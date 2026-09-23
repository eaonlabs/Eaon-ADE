import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  PROVIDERS,
  allEnvNames,
  type EnvFlag,
  type ProviderDef,
  type ProviderState
} from '../shared/integrations'
import { loginShell } from './login-shell'

const run = promisify(execFile)

/**
 * Credentials for the services a pane can act on.
 *
 * Two jobs, and the split between them is the whole design:
 *
 *  1. Work out what is connected, and answer the renderer in names and booleans.
 *  2. Hand the actual values to freshly spawned panes, and to nothing else.
 *
 * Values live in this module and in the environment of the shells it starts.
 * They are never returned from an IPC handler and never written to a log — if
 * you add a `console.log` here, put it on a name, not on what the name holds.
 */

/** Captured once. `null` until the login shell has been asked. */
let loginVars: Record<string, string> | null = null

/**
 * Read the token variables the way the user's own terminal would see them.
 *
 * Launched from the Dock, `process.env` is what `launchd` handed Electron: no
 * `.zshrc`, so none of the exports people actually keep their tokens in. Without
 * this, a provider that is configured perfectly well reports "not configured"
 * to anyone who did not start the app from a terminal.
 *
 * Each value is emitted NUL-terminated in a known order, behind a sentinel, so
 * a chatty shell profile cannot shift the results by one or corrupt a value that
 * legitimately contains a newline.
 */
async function readLoginVars(names: string[]): Promise<Record<string, string>> {
  if (!names.length) return {}
  if (process.platform === 'win32') return {}

  const shell = loginShell()
  const sentinel = 'EAON_ENV_BEGIN'
  // The NUL *before* the sentinel is load-bearing: a profile that prints a
  // banner leaves that text in the same NUL-delimited field as the sentinel,
  // and a sentinel that has to be matched exactly would then never be found.
  const script = [
    `printf '\\0%s\\0' ${sentinel}`,
    ...names.map((n) => `printf '%s\\0' "\${${n}-}"`)
  ].join('\n')

  try {
    const { stdout } = await run(shell, ['-lic', script], {
      timeout: 8000,
      maxBuffer: 1024 * 1024
    })
    const parts = stdout.split('\0')
    const start = parts.indexOf(sentinel)
    if (start === -1) return {}

    const out: Record<string, string> = {}
    names.forEach((name, i) => {
      const value = parts[start + 1 + i]
      if (value) out[name] = value
    })
    return out
  } catch {
    // A missing shell or a profile that hangs is not worth failing over; the
    // app simply falls back to whatever process.env already had.
    return {}
  }
}

/** Prime the cache. Called once at startup so the first panel open is instant. */
export async function loadCredentials(): Promise<void> {
  loginVars = await readLoginVars(allEnvNames())
}

/**
 * The value of a credential variable, wherever it came from.
 *
 * Anything already in `process.env` wins: if you launched the app from a
 * terminal that had a token exported, that is the token you meant to use, and
 * silently preferring the one in your profile would be a surprise.
 */
function valueOf(name: string): string | undefined {
  const live = process.env[name]
  if (live) return live
  return loginVars?.[name] || undefined
}

/**
 * A credential's value, for main-process callers that have to actually
 * authenticate with it — the Linear API client, and nothing else today.
 *
 * The invariant this module exists to keep is "a value never crosses the IPC
 * boundary", not "a value never leaves this file": the main process is
 * trusted, the renderer is not. So this is fine to call from `tasks.ts`, and
 * is never, under any circumstances, returned from an `ipcMain.handle`.
 * `scripts/check-tasks.mjs` greps replies for canary values to keep that
 * honest rather than merely intended.
 */
export function credentialFor(name: string): string | undefined {
  return valueOf(name)
}

/** Names and presence only — the shape that is safe to send to the renderer. */
function flagsFor(def: ProviderDef): EnvFlag[] {
  const seen = new Set<string>()
  const flags: EnvFlag[] = []
  for (const set of def.envSets ?? []) {
    for (const name of set) {
      if (seen.has(name)) continue
      seen.add(name)
      flags.push({ name, set: Boolean(valueOf(name)) })
    }
  }
  return flags
}

/** Is any one group of this provider's variables fully present? */
function hasCompleteSet(def: ProviderDef): boolean {
  return (def.envSets ?? []).some((set) => set.every((name) => Boolean(valueOf(name))))
}

/** A group that was started and not finished — the most useful thing to report. */
function partialSet(def: ProviderDef): string[] | null {
  for (const set of def.envSets ?? []) {
    const missing = set.filter((name) => !valueOf(name))
    if (missing.length && missing.length < set.length) return missing
  }
  return null
}

/**
 * Who a CLI says you are.
 *
 * `gh` and `glab` both print their status to stderr on some versions and stdout
 * on others, and both exit non-zero when signed out — so the text is read from
 * whichever stream carried it, including on failure.
 */
async function cliAccount(bin: string): Promise<string | null> {
  const text = await (async (): Promise<string> => {
    try {
      const { stdout, stderr } = await run(bin, ['auth', 'status'], { timeout: 8000 })
      return `${stdout}\n${stderr}`
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      return `${e.stdout ?? ''}\n${e.stderr ?? ''}`
    }
  })()

  if (!/logged in/i.test(text)) return null
  // "Logged in to github.com account octocat" (gh 2.40+)
  // "Logged in to gitlab.com as octocat"      (glab)
  const match = text.match(/logged in to \S+ (?:account|as) ([^\s(]+)/i)
  return match ? match[1].trim() : 'signed in'
}

type Which = (bin: string) => Promise<string | null>

async function stateFor(def: ProviderDef, which: Which): Promise<ProviderState> {
  const env = flagsFor(def)
  const base = { id: def.id, env }

  // A token beats the CLI: it is what gh itself would use, and it works even
  // where the CLI is not installed at all.
  if (hasCompleteSet(def)) {
    const names = env.filter((f) => f.set).map((f) => f.name)
    return {
      ...base,
      status: 'connected',
      account: null,
      detail: `Using ${names.join(' + ')}.`
    }
  }

  if (def.bin) {
    const found = await which(def.bin)
    if (!found) {
      return {
        ...base,
        status: 'not-installed',
        account: null,
        detail: `${def.bin} is not on your PATH.`
      }
    }
    /*
     * Run the path `which` just resolved, not the bare name.
     *
     * Launched from the Dock, this process has launchd's PATH —
     * /usr/bin:/bin:/usr/sbin:/sbin — and nothing else. `gh` lives in
     * /opt/homebrew/bin, so `execFile('gh')` is ENOENT, the catch below turns
     * that into empty output, empty output does not say "logged in", and a
     * perfectly signed-in user was told to run `gh auth login`. `which` had
     * already asked the login shell and knew exactly where it was; throwing
     * that answer away was the whole bug.
     */
    const exe = found.startsWith('/') ? found : def.bin
    const account = await cliAccount(exe)
    if (account) {
      return { ...base, status: 'connected', account, detail: `Signed in through ${def.bin}.` }
    }
    return {
      ...base,
      status: 'needs-auth',
      account: null,
      detail: `Run ${def.bin} auth login in any pane.`
    }
  }

  const missing = partialSet(def)
  if (missing) {
    return {
      ...base,
      status: 'needs-auth',
      account: null,
      detail: `Still needs ${missing.join(' and ')}.`
    }
  }

  return { ...base, status: 'not-configured', account: null, detail: 'No credentials set.' }
}

/** Every provider, checked concurrently. Order matches the registry, not the clock. */
export async function detectProviders(which: Which): Promise<ProviderState[]> {
  if (loginVars === null) await loadCredentials()
  return Promise.all(PROVIDERS.map((def) => stateFor(def, which)))
}

/** Re-read the shell, then re-check. What the panel's refresh button calls. */
export async function refreshProviders(which: Which): Promise<ProviderState[]> {
  loginVars = await readLoginVars(allEnvNames())
  return detectProviders(which)
}

/**
 * The credential variables to give a new pane.
 *
 * Only what came from the login shell — anything already in `process.env` is
 * inherited by the pane anyway, and re-setting it here would let a stale
 * captured value quietly override the live one.
 */
export function sessionEnv(): Record<string, string> {
  if (!loginVars) return {}
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(loginVars)) {
    if (!process.env[name] && value) out[name] = value
  }
  return out
}
