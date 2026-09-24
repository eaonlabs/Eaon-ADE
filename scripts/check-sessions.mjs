/*
 * Checks that a pane's shell survives the renderer going away.
 *
 * The bug this guards is the one people actually felt: sessions ending on
 * their own, with nobody touching anything. Shells live in the main process,
 * so a renderer crash does not harm them — but the crash handler killed every
 * one of them before reloading, and `spawn()` began by killing whatever was in
 * the pane's slot. Between them, one crash of a window ended every agent in
 * every workspace, mid-task.
 *
 * Both halves are asserted here against real shells, because the interesting
 * claim is "the same process is still there afterwards", and only a pid can
 * say that.
 *
 *   node scripts/check-sessions.mjs
 */

import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-sessions-'))

let pass = 0
const failures = []
function check(name, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---- bundle the manager, with electron stubbed ------------------------ */

const shim = path.join(tmp, 'electron.js')
fs.writeFileSync(shim, 'export const app = { getVersion: () => "0.0.0-check" }\n')

// Inside the repo, so Node can still resolve node-pty from the bundle — it is
// a native module and has to stay a real require.
const cache = path.join(root, 'node_modules/.cache/eaon-check')
fs.mkdirSync(cache, { recursive: true })
const outfile = path.join(cache, 'pty-manager.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/pty-manager.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  // node-pty is a native module; it has to stay a real require at run time.
  external: ['node-pty'],
  alias: { electron: shim }
})
const { PtyManager } = await import(outfile)

const ptys = new PtyManager()
ptys.setSender(() => {})

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/* ---- a shell survives the renderer asking for it again ----------------- */

console.log('\nreattach')

const PANE = 'pane_check_1'
const first = ptys.spawn({ paneId: PANE, cwd: tmp, cols: 80, rows: 24 })
check('a pane gets a shell', first.ok === true, first.error)
await sleep(300)
const pid1 = ptys.pids().get(PANE) ?? null
check('and it is a real running process', typeof pid1 === 'number' && alive(pid1), `pid ${pid1}`)

/*
 * This is the reload. The renderer came back and asked for a shell for the
 * same pane, pointed at the same place — which is what it does after a crash,
 * and what used to kill the agent that was mid-task.
 */
const again = ptys.spawn({ paneId: PANE, cwd: tmp, cols: 100, rows: 30 })
check('asking again is answered, not refused', again.ok === true, again.error)
check('and it says it handed back the running one', again.reattached === true)
await sleep(200)
const pid2 = ptys.pids().get(PANE) ?? null
check('the very same process is still there', pid1 !== null && pid2 === pid1, `${pid1} → ${pid2}`)
check('and it is still alive', typeof pid2 === 'number' && alive(pid2), `pid ${pid2}`)

/* ---- but only when the request is really the same ---------------------- */

console.log('\na different request still gets a different shell')

const elsewhere = fs.mkdtempSync(path.join(tmp, 'other-'))
const moved = ptys.spawn({ paneId: PANE, cwd: elsewhere, cols: 80, rows: 24 })
check('a pane pointed somewhere new is not reattached', moved.reattached !== true)
await sleep(300)
const pid3 = ptys.pids().get(PANE) ?? null
check('it got a new shell', pid3 !== null && pid3 !== pid1, `${pid1} → ${pid3}`)
await sleep(200)
check('and the old one was ended', pid1 === null || !alive(pid1), `pid ${pid1} still alive`)

/* ---- an explicit stop still stops ------------------------------------- */

console.log('\nstopping still stops')

ptys.kill(PANE)
await sleep(300)
check('kill ends the shell', pid3 === null || !alive(pid3), `pid ${pid3} still alive`)
const fresh = ptys.spawn({ paneId: PANE, cwd: tmp, cols: 80, rows: 24 })
check('and the pane can be started again afterwards', fresh.ok === true && fresh.reattached !== true)

/* ---- the refusal that was reported ------------------------------------- */

console.log('\nrefusing to start one more')

const memOut = path.join(cache, 'memory.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/memory.ts')],
  outfile: memOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  external: ['electron']
})
const { pressureFor } = await import(memOut)

/*
 * The numbers off a real machine that had just lost sessions: 133 MB of RAM
 * free with 864 MB left of 2048 MB of swap, eighteen agents holding 4.6 GB
 * between them. Starting a nineteenth is what the kernel answers by killing
 * one of the eighteen, so the app refuses instead — and the refusal has to
 * keep working, because the alternative is losing work somebody is doing.
 */
check(
  'a machine with 133 MB free and 864 MB of swap is refused',
  pressureFor(133, 864, 2048) === 'critical',
  pressureFor(133, 864, 2048)
)
// Still comfortable: refusing here would be refusing on a healthy machine.
check('one with room is not refused', pressureFor(4096, 8192, 12288) === 'ok')
// The shape in between, where it is worth saying something but not refusing.
check('the tight middle is neither', pressureFor(800, 2000, 4096) === 'tight',
  pressureFor(800, 2000, 4096))

/* ---- saying why a session went ---------------------------------------- */

const reasonOut = path.join(cache, 'exit.mjs')
await build({
  entryPoints: [path.join(root, 'src/shared/exit.ts')],
  outfile: reasonOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { exitReason, killedByOs } = await import(reasonOut)

console.log('\nexplaining the exit')

/*
 * The whole of the "session unexpectedly quit" report. An out-of-memory kill
 * arrives as exit code 0 with signal 9 — a *zero* exit code — so every test
 * the app had was false and the pane went quiet with nothing said. If this
 * assertion ever goes back to null, the silence comes back with it.
 */
check(
  'an out-of-memory kill is explained, not read as a clean exit',
  exitReason(0, 9) === 'The system stopped this agent to reclaim memory.',
  String(exitReason(0, 9))
)
check('and it is named as the system doing it', killedByOs(9) === true)

/*
 * The app's own stop path. Measured: a shell stopped through kill() on macOS
 * comes back as exit code *1*, not a signal, so nothing about the exit itself
 * says it was wanted — only `requested` does. Without it every stop somebody
 * pressed raised an error about the session they had just closed, which is how
 * a real warning gets trained into background noise.
 */
check('a stop somebody asked for says nothing', exitReason(1, 0, true) === null,
  String(exitReason(1, 0, true)))
check('even when it took a SIGKILL to finish', exitReason(0, 9, true) === null,
  String(exitReason(0, 9, true)))
check('and it is not blamed on the system', killedByOs(9, true) === false)
check('a shell that was told to exit says nothing', exitReason(0) === null, String(exitReason(0)))
check('and that is not the system either', killedByOs(undefined) === false)

// A non-zero code still reports, as it always did.
check('a bad exit code still reports', exitReason(127) === 'The shell stopped with code 127.',
  String(exitReason(127)))
// An agent that came apart is not the same thing as a machine that is full.
check('a crash is told apart from a kill', exitReason(0, 11) === 'This agent stopped on a segmentation fault.',
  String(exitReason(0, 11)))

/* ---- and the bridge actually carries the signal ------------------------ */

/*
 * Asserted against the preload source because that is where it was lost: the
 * main process emitted { paneId, exitCode, signal } and the bridge destructured
 * only the first two, so the renderer could never have known.
 */
const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
const bridge = preload.slice(preload.indexOf('onExit:'), preload.indexOf('onExit:') + 400)
check('the preload passes the exit signal through', /signal/.test(bridge))
const manager = fs.readFileSync(path.join(root, 'src/main/pty-manager.ts'), 'utf8')
check("and the main process still sends it", /emit\('pty:exit',[^)]*signal/.test(manager))

/* ---- clean up --------------------------------------------------------- */

ptys.killAll()
await sleep(300)
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
