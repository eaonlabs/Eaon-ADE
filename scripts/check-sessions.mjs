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

/* ---- clean up --------------------------------------------------------- */

ptys.killAll()
await sleep(300)
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
