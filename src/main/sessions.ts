import fs from 'node:fs/promises'
import { closeSync, createReadStream, openSync, readSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS, BYPASS_FLAGS, SESSION_FLAGS, type ResumableSession } from '../shared/types'
import { isInside } from '../shared/paths'

/**
 * An agent conversation seen running in a pane, as opposed to one the app
 * started itself.
 *
 * Most sessions begin by hand: you open a plain shell and type `claude`. The
 * pane's own record knows nothing about that — it was created as a shell and
 * stays one — so what was actually running has to be watched for and written
 * down separately. That is what this is, and it is why a pane can come back to
 * a conversation nobody ever told the app about.
 */
export interface ObservedSession {
  agentId: string
  sessionId: string
  /** Where the agent was started, which is the folder its transcript is filed under. */
  cwd: string
  /** When it was last seen alive, so records for panes long gone can be dropped. */
  at: number
}

/** Reads the first `bytes` of a file without pulling the whole thing into memory. */
async function readHead(file: string, bytes = 8192): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    const stream = createReadStream(file, { start: 0, end: bytes, encoding: 'utf8' })
    stream.on('data', (c) => {
      out += c
    })
    stream.on('end', () => resolve(out))
    stream.on('error', () => resolve(''))
  })
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = text.match(re)
  return m ? m[1] : null
}

const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/

/**
 * The folder a transcript was recorded in.
 *
 * Usually in the first line, but not always — a session that opens with a long
 * summary can push it well past the head we read. Those get one deeper pass,
 * because a session with no folder cannot be shown when the list is narrowed to
 * one project, and silently dropping it is worse than the extra read.
 */
async function readCwd(file: string, head: string): Promise<string> {
  const found = firstMatch(head, CWD_RE) ?? firstMatch(await readHead(file, 262144), CWD_RE)
  return found ? found.replace(/\\\\/g, '\\').replace(/\\"/g, '"') : ''
}

function tidy(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * How many transcripts to open per scan.
 *
 * Every session is returned with the folder it ran in so the caller can narrow
 * the list to one project. That filter has to be applied to the whole set, not
 * to a page of it — slicing to a handful of the most recent first would let a
 * busy project crowd out every session belonging to the folder you are actually
 * in, and the list would look empty when it is not.
 */
const MAX_SCAN = 400

/** The folder name Claude Code derives from a working directory. */
export function projectSlug(cwd: string): string {
  // Character for character, with no collapsing of runs: /a/-b becomes -a--b.
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Where Claude Code keeps one directory of transcripts per project.
 *
 * Asked rather than computed, because it moves. Each signed-in account has its
 * own configuration directory and therefore its own transcripts, so which ones
 * count — for the usage readout, for the resume list, for knowing what a pane
 * was running — depends on the account that is active. Answering from
 * `~/.claude` regardless would show one account's work under another's name.
 */
let resolveProjectsRoot: () => string = () => path.join(os.homedir(), '.claude', 'projects')

export function setProjectsRoot(fn: () => string): void {
  resolveProjectsRoot = fn
}

export function projectsRoot(): string {
  return resolveProjectsRoot()
}

/**
 * Where Claude Code notes which conversation each running process is holding.
 *
 * Beside the transcripts rather than beside the home directory, so it follows
 * whichever account is active for the same reason they do.
 */
export function sessionsRoot(): string {
  return path.join(path.dirname(projectsRoot()), 'sessions')
}

/**
 * The project directories holding a folder's transcripts.
 *
 * The directory name is derived from the path, so normally one string
 * comparison finds it. That derivation belongs to Claude Code rather than to
 * us, though, and a Windows path is a different shape — a drive letter, a
 * colon, backslashes. Rather than assume the derivation matches there, fall
 * back to asking the transcripts where they actually ran. That is
 * authoritative on every platform and costs one short read per project, not
 * per session.
 */
export async function projectDirsFor(cwd: string): Promise<string[]> {
  const root = projectsRoot()
  let dirs: string[]
  try {
    dirs = await fs.readdir(root)
  } catch {
    return []
  }

  const slug = projectSlug(cwd)
  const byName = dirs.filter((d) => d === slug || d.startsWith(`${slug}-`))
  if (byName.length) return byName

  const found: string[] = []
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await fs.readdir(path.join(root, dir))
    } catch {
      continue
    }
    const sample = entries.find((e) => e.endsWith('.jsonl'))
    if (!sample) continue
    const file = path.join(root, dir, sample)
    const recorded = await readCwd(file, await readHead(file))
    if (recorded && isInside(recorded, cwd)) found.push(dir)
  }
  return found
}

/**
 * Claude Code keeps one JSONL transcript per session under
 * ~/.claude/projects/<slugified-cwd>/<session-id>.jsonl. Each of those is
 * resumable with `claude --resume <id>`, so we can offer them back.
 */
async function claudeSessions(limit: number): Promise<ResumableSession[]> {
  const root = projectsRoot()
  let projectDirs: string[]
  try {
    projectDirs = await fs.readdir(root)
  } catch {
    return []
  }

  const found: { file: string; dir: string; id: string; mtime: number }[] = []
  for (const dir of projectDirs) {
    const full = path.join(root, dir)
    let entries: string[]
    try {
      entries = await fs.readdir(full)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      try {
        const stat = await fs.stat(path.join(full, entry))
        if (stat.size < 64) continue
        found.push({
          file: path.join(full, entry),
          dir,
          id: entry.replace(/\.jsonl$/, ''),
          mtime: stat.mtimeMs
        })
      } catch {
        /* skip unreadable transcripts */
      }
    }
  }

  found.sort((a, b) => b.mtime - a.mtime)
  const head = found.slice(0, Math.max(limit, MAX_SCAN))

  // One folder per directory, so a transcript that never recorded its cwd can
  // borrow it from a sibling. Without this those sessions have no folder at all
  // and vanish the moment the list is narrowed to one project.
  const cwdByDir = new Map<string, string>()

  const out: (ResumableSession & { dir: string })[] = []
  for (const item of head) {
    const text = await readHead(item.file)
    const cwd = await readCwd(item.file, text)
    if (cwd && !cwdByDir.has(item.dir)) cwdByDir.set(item.dir, cwd)

    const content = firstMatch(text, /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    let label = 'Session'
    if (content) {
      try {
        label = tidy(JSON.parse(`"${content}"`))
      } catch {
        label = tidy(content)
      }
    }
    out.push({
      id: item.id,
      tool: 'Claude Code',
      cwd,
      dir: item.dir,
      label: label || 'Session',
      command: `claude --resume ${item.id}`,
      updatedAt: item.mtime
    })
  }

  return out.map(({ dir, ...session }) => ({
    ...session,
    cwd: session.cwd || cwdByDir.get(dir) || ''
  }))
}

/**
 * Where the active Codex account keeps its rollouts.
 *
 * Set from the accounts layer at startup, for the same reason the usage
 * reader is: switching accounts has to change which transcripts are listed,
 * and a hard-coded `~/.codex` would keep offering the previous account's
 * sessions after a switch. Null means no override, i.e. plain `~/.codex`.
 */
let codexHome: () => string | null = () => null

export function setCodexHome(fn: () => string | null): void {
  codexHome = fn
}

/** Codex writes rollout transcripts under $CODEX_HOME/sessions when installed. */
async function codexSessions(limit: number): Promise<ResumableSession[]> {
  const root = path.join(codexHome() ?? path.join(os.homedir(), '.codex'), 'sessions')
  const found: { file: string; id: string; mtime: number }[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4 || found.length > 400) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const stat = await fs.stat(full)
          const id =
            firstMatch(entry.name, /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ??
            entry.name.replace(/\.jsonl$/, '')
          found.push({ file: full, id, mtime: stat.mtimeMs })
        } catch {
          /* skip */
        }
      }
    }
  }

  await walk(root, 0)
  found.sort((a, b) => b.mtime - a.mtime)

  const out: ResumableSession[] = []
  for (const item of found.slice(0, limit)) {
    const text = await readHead(item.file)
    out.push({
      id: item.id,
      tool: 'Codex',
      cwd: await readCwd(item.file, text),
      label: tidy(firstMatch(text, /"instructions"\s*:\s*"((?:[^"\\]|\\.)*)"/) ?? 'Session'),
      command: `codex resume ${item.id}`,
      updatedAt: item.mtime
    })
  }
  return out
}

/**
 * Every resumable session on this machine, newest first, each carrying the
 * folder it ran in. Narrowing to a single project is the caller's job: it is
 * the renderer that knows which workspace you are looking at, and it can
 * re-narrow as you switch between them without going back to disk.
 */
export async function listResumable(limit = MAX_SCAN): Promise<ResumableSession[]> {
  const [claude, codex] = await Promise.all([claudeSessions(limit), codexSessions(limit)])
  return [...claude, ...codex].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

/** How many transcripts exist for a folder — shown next to recent folders. */
export async function sessionCountFor(cwd: string): Promise<number> {
  const root = projectsRoot()
  let total = 0
  for (const dir of await projectDirsFor(cwd)) {
    try {
      const entries = await fs.readdir(path.join(root, dir))
      total += entries.filter((e) => e.endsWith('.jsonl')).length
    } catch {
      /* the directory went away between listing and reading */
    }
  }
  return total
}

/**
 * Enough of a transcript to find its opening turn.
 *
 * These files reach hundreds of megabytes, and the first thing anybody said is
 * within the first few kilobytes of every one of them, so the head is read and
 * the rest is left alone.
 */
const HEAD_BYTES = 256 * 1024

/** A line that means somebody spoke, as opposed to session bookkeeping. */
const TURN_RE = /"type"\s*:\s*"(?:user|assistant)"/

/**
 * How usable a session id is, which is not a yes or no question.
 *
 * Three states, because two of them fail in opposite directions and want
 * opposite commands:
 *
 *   'conversation' — turns are on disk, and `--resume` reopens them.
 *   'none'         — nothing is filed under this id, so `--session-id` can
 *                    claim it and the pane keeps the same conversation the
 *                    next time it opens.
 *   'reserved'     — a file exists but holds no conversation, which happens
 *                    when an agent is started and closed without a word. Both
 *                    of the above are refused here: `--resume` answers "No
 *                    conversation found with session ID" and `--session-id`
 *                    answers "Session ID is already in use". Both measured,
 *                    against this machine. The id is spent, and the only thing
 *                    left that works is to start clean.
 */
type SessionState = 'conversation' | 'reserved' | 'none'

function fileState(file: string): SessionState {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return 'none'
  }
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES)
    const read = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return read > 0 && TURN_RE.test(buf.toString('utf8', 0, read)) ? 'conversation' : 'reserved'
  } catch {
    return 'reserved'
  } finally {
    closeSync(fd)
  }
}

function sessionState(cwd: string, sessionId: string): SessionState {
  // A session id is ours, but it still ends up in a path. Anything that is not
  // one is treated as spent, so it is never handed to a flag.
  if (!cwd || !sessionId || !/^[0-9a-fA-F-]{36}$/.test(sessionId)) return 'reserved'
  /*
   * The one directory the folder derives to, and deliberately not the wider
   * search `projectDirsFor` does.
   *
   * That one also takes directories beginning with the slug, which is right
   * when listing what could be resumed and wrong here. The names collide: a
   * folder called `Eaon` and one called `Eaon ADE` derive to `…-Eaon` and
   * `…-Eaon-ADE`, and the second reads as a continuation of the first. Reopening
   * is asked for from a working directory, and the agent looks under the
   * directory that working directory derives to — so a conversation filed under
   * a neighbour's name is not this one's to offer, and offering it produces the
   * "No conversation found" this is all meant to prevent.
   */
  return fileState(path.join(projectsRoot(), projectSlug(cwd), `${sessionId}.jsonl`))
}

/**
 * Whether a conversation can actually be reopened — which is not the same
 * question as whether a file exists.
 *
 * An agent started and never spoken to writes no transcript at all, and one
 * interrupted early leaves a few hundred bytes of mode and snapshot records
 * with no conversation inside them. `claude --resume` answers both with "No
 * conversation found with session ID" — measured against a real one, not
 * assumed — so a turn somebody actually took is what is looked for here.
 *
 * Getting this wrong is not cosmetic. The pane comes back to an error message
 * where the work it was holding should have been.
 */
export function hasTranscript(cwd: string, sessionId: string): boolean {
  return sessionState(cwd, sessionId) === 'conversation'
}

/** Wraps a path so a shell reads it as one word, however it is spelled. */
function quote(dir: string): string {
  return `'${dir.replace(/'/g, `'\\''`)}'`
}

/**
 * Reopening a conversation that was seen running, from wherever it was running.
 *
 * The folder is part of the answer. A transcript is filed under the directory
 * the agent started in, so a session begun after a `cd` cannot be found from
 * the pane's own root — carrying the directory along with the command is what
 * brings those back rather than dropping them.
 */
function resumeObserved(observed: ObservedSession, paneCwd: string): string | null {
  const flags = SESSION_FLAGS[observed.agentId]
  const bin = AGENTS.find((a) => a.id === observed.agentId)?.bin
  if (!flags || !bin) return null
  const cwd = observed.cwd || paneCwd
  if (!hasTranscript(cwd, observed.sessionId)) return null
  const line = `${bin} ${flags.resume} ${observed.sessionId}`
  return cwd === paneCwd ? line : `cd ${quote(cwd)} && ${line}`
}

/**
 * The command a pane should actually run.
 *
 * Same pane, same conversation, whether this is the first launch or the tenth:
 * the id is pinned when there is nothing to reopen and resumed once there is.
 * Deciding it here, at the moment of spawning, means the answer is always taken
 * from what is on disk right now rather than from something written down
 * earlier that may since have stopped being true.
 */
export function launchCommand(req: {
  command?: string | null
  agentId?: string
  sessionId?: string | null
  cwd: string
  /** What this pane was last seen running, whoever started it. */
  observed?: ObservedSession | null
  /** Settings.bypassPermissions — start agents with their prompting off. */
  bypass?: boolean
}): string | null {
  const line = resolveLaunch(req)
  if (!req.bypass) return line
  // Whichever branch produced the line decides whose agent it is: a resumed
  // observation carries its own, because the pane's record may still say it is
  // a plain shell.
  return withBypass(line, req.observed?.agentId ?? req.agentId)
}

/**
 * Appends the agent's skip-permissions flag, once.
 *
 * Applied here rather than where a pane is created because this is the only
 * funnel every launch passes through — a new pane, a pane restored on reopen,
 * and a conversation resumed from what was seen running all end up here. Doing
 * it at pane-creation time would have covered only the first, and would also
 * have baked the flag into `state.json`, where it would outlive the setting
 * that asked for it.
 *
 * The flag goes last so it survives `cd … && claude --resume <id>`, where the
 * binary is not the first word on the line.
 */
function withBypass(line: string | null, agentId: string | undefined): string | null {
  if (!line || !agentId) return line
  const flag = BYPASS_FLAGS[agentId]
  // A command the user wrote themselves already saying it is left alone.
  if (!flag || new RegExp(`(^|\\s)${flag}(\\s|=|$)`).test(line)) return line
  return `${line} ${flag}`
}

function resolveLaunch(req: {
  command?: string | null
  agentId?: string
  sessionId?: string | null
  cwd: string
  observed?: ObservedSession | null
}): string | null {
  const { command, agentId, sessionId, cwd, observed } = req

  /*
   * Observation beats intention.
   *
   * Most conversations are not started by the app. You open a plain shell and
   * type `claude`, and the pane's own record — created as a shell, with no
   * agent and no command — never learns otherwise. Reading what was actually
   * running is the only thing that brings those back, and where the two
   * disagree the one that was watched is the one that was true.
   */
  if (observed) {
    const resumed = resumeObserved(observed, cwd)
    if (resumed) return resumed
  }

  if (!command || !agentId || !sessionId) return command ?? null

  const flags = SESSION_FLAGS[agentId]
  if (!flags) return command

  // A command that already names a session — one resumed by hand from the
  // picker, say — is left exactly as the caller wrote it.
  if (/(^|\s)--(resume|session-id|continue)(\s|=|$)/.test(command)) return command

  const state = sessionState(cwd, sessionId)
  // Neither flag works on a spent id, and a pane that opens on an error message
  // is worse than one that opens on a fresh conversation. The watch will learn
  // whatever this turns into.
  if (state === 'reserved') return command
  return `${command} ${state === 'conversation' ? flags.resume : flags.pin} ${sessionId}`
}
