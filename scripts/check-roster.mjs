/*
 * Checks the agent roster the rail draws under a workspace.
 *
 * All of it is pure — no store, no React — so it runs straight off the shared
 * module. The cases worth pinning down are the ones that are wrong in a way
 * you would not notice on your own machine: a roster that quietly counts a
 * bare shell as an agent, an elapsed time that rounds the wrong way so a
 * stale answer reads as fresh, and the ordering, which must not follow state
 * or the list reshuffles itself under the pointer every time an agent starts.
 *
 *   node scripts/check-roster.mjs
 */

import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-roster-'))

let pass = 0
const failures = []
let group = ''
const describe = (name) => {
  group = name
  console.log(`\n\x1b[1m${name}\x1b[0m`)
}
const ok = (label, cond, detail) => {
  if (cond) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${label}`)
  } else {
    failures.push(`${group} › ${label}${detail ? `\n      ${detail}` : ''}`)
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `\n      ${detail}` : ''}`)
  }
}
const eq = (label, actual, expected) =>
  ok(label, Object.is(actual, expected), `expected ${expected}, got ${actual}`)

/* ── load the shared module ───────────────────────────────────────────────── */

const bundle = path.join(tmp, 'roster.mjs')
await build({
  entryPoints: [path.join(root, 'src/shared/roster.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { isAgentPane, stateOf, sinceOf, rosterFor, summarise, relTime, stateLabel } = await import(
  pathToFileURL(bundle).href
)

const NOW = 1_800_000_000_000
const MIN = 60_000

/** A pane, defaulted to the dullest possible one. */
const pane = (over = {}) => ({
  id: 'p1',
  name: 'Tate',
  title: null,
  cwd: '/Users/me/app',
  agentId: 'claude',
  command: 'claude',
  status: 'idle',
  working: false,
  branch: null,
  contextPct: null,
  sessionId: null,
  createdAt: NOW - 10 * MIN,
  ...over
})

/* ── what counts as an agent ──────────────────────────────────────────────── */
{
  describe('what counts as an agent')
  eq('an agent pane does', isAgentPane(pane()), true)
  eq('a bare shell does not', isAgentPane(pane({ agentId: 'shell' })), false)
  eq('a preview pane does not', isAgentPane(pane({ kind: 'preview' })), false)
  eq('a diff pane does not', isAgentPane(pane({ kind: 'diff' })), false)
  eq(
    'an explicit terminal kind still does',
    isAgentPane(pane({ kind: 'terminal' })),
    true
  )
  // The count in the roster's header has to mean something different from the
  // pane count already sitting on the row above it, or it is noise.
  const mixed = [pane({ id: 'a' }), pane({ id: 'b', agentId: 'shell' }), pane({ id: 'c', kind: 'preview' })]
  eq('so a mixed workspace counts only the agents', rosterFor(mixed, NOW).length, 1)
}

/* ── which state a pane is in ─────────────────────────────────────────────── */
{
  describe('which state a pane is in')
  eq('idle by default', stateOf(pane()), 'idle')
  eq('working when it is working', stateOf(pane({ working: true })), 'working')
  eq('attention when it rang the bell', stateOf(pane({ status: 'attention' })), 'attention')
  eq('exited when the command ended', stateOf(pane({ status: 'exited' })), 'exited')

  // The two orderings that are easy to get backwards.
  eq(
    'exited beats a stale working flag',
    stateOf(pane({ status: 'exited', working: true })),
    'exited'
  )
  eq(
    'attention beats working, because it is the one that wants you',
    stateOf(pane({ status: 'attention', working: true })),
    'attention'
  )
  // 'live' only means bytes arrived, which is true while you type into a
  // prompt. It must not read as an agent doing something.
  eq('a live pane that is not working is idle', stateOf(pane({ status: 'live' })), 'idle')
}

/* ── how long it has been that way ────────────────────────────────────────── */
{
  describe('how long it has been that way')
  eq(
    'measured from the last transition when there is one',
    sinceOf(pane({ lastActiveAt: NOW - 5 * MIN }), NOW),
    5 * MIN
  )
  eq(
    'and from creation when there is not',
    sinceOf(pane({ createdAt: NOW - 7 * MIN }), NOW),
    7 * MIN
  )
  // A state file written before the field existed restores panes without it;
  // falling back keeps those rows honest instead of showing the epoch.
  eq(
    'an undefined stamp does not become a 56-year-old pane',
    sinceOf(pane({ lastActiveAt: undefined, createdAt: NOW - MIN }), NOW),
    MIN
  )
  eq('a clock that went backwards clamps at zero', sinceOf(pane({ lastActiveAt: NOW + MIN }), NOW), 0)

  eq('a working pane reports no elapsed time at all', rosterFor([pane({ working: true })], NOW)[0].sinceMs, null)
  eq(
    'an idle one reports the gap',
    rosterFor([pane({ lastActiveAt: NOW - 3 * MIN })], NOW)[0].sinceMs,
    3 * MIN
  )
}

/* ── the elapsed column ───────────────────────────────────────────────────── */
{
  describe('the elapsed column')
  eq('under a minute is now', relTime(59_000), 'now')
  eq('a minute is a minute', relTime(60_000), '1m')
  eq('minutes up to the hour', relTime(59 * MIN), '59m')
  eq('then hours', relTime(60 * MIN), '1h')
  eq('hours up to the day', relTime(23 * 60 * MIN), '23h')
  eq('then days', relTime(24 * 60 * MIN), '1d')

  // Never rounded up. The number says how stale the answer is, so erring
  // towards fresher is the one direction that actually misleads.
  eq('59 minutes is not an hour', relTime(59 * MIN + 59_000), '59m')
  eq('23 hours is not a day', relTime(24 * 60 * MIN - 1000), '23h')
}

/* ── the collapsed chip ───────────────────────────────────────────────────── */
{
  describe('the collapsed chip')
  eq('says nothing about an empty workspace', summarise([]).count, 0)
  eq('and has no state to show for it', summarise([]).state, null)

  const of = (...panes) => summarise(rosterFor(panes, NOW))
  eq('counts the agents', of(pane({ id: 'a' }), pane({ id: 'b' })).count, 2)
  eq('idle when they all are', of(pane({ id: 'a' }), pane({ id: 'b' })).state, 'idle')

  // Shut, it still has to say that something in there wants you — that is the
  // whole reason the state is on the chip and not only in the open list.
  eq(
    'surfaces working over idle',
    of(pane({ id: 'a' }), pane({ id: 'b', working: true })).state,
    'working'
  )
  eq(
    'and attention over working',
    of(pane({ id: 'a', working: true }), pane({ id: 'b', status: 'attention' })).state,
    'attention'
  )
  eq(
    'and exited over idle',
    of(pane({ id: 'a' }), pane({ id: 'b', status: 'exited' })).state,
    'exited'
  )
  eq(
    'attention wins however late in the list it sits',
    of(pane({ id: 'a' }), pane({ id: 'b' }), pane({ id: 'c', status: 'attention' })).state,
    'attention'
  )
}

/* ── the order of the rows ────────────────────────────────────────────────── */
{
  describe('the order of the rows')
  const panes = [
    pane({ id: 'a', name: 'Ada' }),
    pane({ id: 'b', name: 'Bo', status: 'attention' }),
    pane({ id: 'c', name: 'Cy', working: true })
  ]
  const ids = rosterFor(panes, NOW).map((e) => e.id ?? e.paneId)
  eq('follows the panes, not their state', ids.join(','), 'a,b,c')

  // The reason: the list is read beside the grid it describes. If it sorted by
  // state, row three would stop being pane three the moment an agent started.
  const busy = [
    pane({ id: 'a', name: 'Ada', working: true }),
    pane({ id: 'b', name: 'Bo', status: 'attention' }),
    pane({ id: 'c', name: 'Cy' })
  ]
  eq(
    'and does not reshuffle when they start and stop',
    rosterFor(busy, NOW).map((e) => e.paneId).join(','),
    'a,b,c'
  )
  eq('each row keeps its pane handle for addressing', rosterFor(panes, NOW)[1].name, 'Bo')
}

/* ── what the rows say ────────────────────────────────────────────────────── */
{
  describe('what the rows say')
  eq('idle', stateLabel('idle'), 'Idle')
  eq('working', stateLabel('working'), 'Working')
  eq('exited', stateLabel('exited'), 'Exited')
  // Not "Attention": the row is telling you to go and do something.
  eq('attention is phrased as a request', stateLabel('attention'), 'Needs you')
}

/* ── done ─────────────────────────────────────────────────────────────────── */

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
