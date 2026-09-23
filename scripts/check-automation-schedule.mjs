/*
 * Checks when a `daily` automation is due, and when it deliberately is not.
 *
 * All of it is pure — no store, no Electron — so it runs straight off the
 * shared module. The cases that matter are the ones that are easy to get
 * wrong and invisible when you do: a laptop opened in the evening must not
 * fire a morning automation, a long-running app must roll over at midnight,
 * and neither of the two days a year that are not 24 hours long may shift a
 * schedule by an hour.
 *
 * Timezone is switched per case via process.env.TZ, which Node honours for
 * Dates created afterwards — verified at the top, so a platform where that
 * stopped being true fails loudly instead of silently testing one zone twice.
 *
 *   node scripts/check-automation-schedule.mjs
 */

import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-autosched-'))

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

const bundle = path.join(tmp, 'automations.mjs')
await build({
  entryPoints: [path.join(root, 'src/shared/automations.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { isDailyDue, dueAutomations, scheduledOn, isSameLocalDay, firesOnOpen } = await import(
  pathToFileURL(bundle).href
)

/* ── helpers ──────────────────────────────────────────────────────────────── */

const mk = (over = {}) => ({
  id: 'a1',
  name: 'Morning review',
  prompt: 'review the diff',
  agentId: 'claude',
  cwd: '/Users/me/app',
  trigger: { kind: 'daily', at: '09:00' },
  lastRunAt: null,
  ...over
})

/** Local wall-clock instant, in whatever TZ is currently set. */
const local = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime()

const withTz = (tz, fn) => {
  const before = process.env.TZ
  process.env.TZ = tz
  try {
    fn()
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

/* ── the TZ switching this whole file depends on ──────────────────────────── */

describe('0. the harness itself')
{
  let ny, lon
  withTz('America/New_York', () => (ny = new Date(2026, 5, 1, 12, 0).toISOString()))
  withTz('Europe/London', () => (lon = new Date(2026, 5, 1, 12, 0).toISOString()))
  ok('process.env.TZ actually changes how local Dates resolve', ny !== lon, `${ny} vs ${lon}`)
}

/* ── the ordinary day ─────────────────────────────────────────────────────── */

describe('1. an ordinary day')
withTz('America/New_York', () => {
  const watching = local(2026, 6, 10, 8, 0) // app opened at 08:00
  eq(
    'not due a minute before its time',
    isDailyDue(mk(), local(2026, 6, 10, 8, 59), watching),
    false
  )
  eq('due on the minute', isDailyDue(mk(), local(2026, 6, 10, 9, 0), watching), true)
  eq('still due later the same day', isDailyDue(mk(), local(2026, 6, 10, 11, 0), watching), true)
  eq(
    'not due again once it has run today',
    isDailyDue(mk({ lastRunAt: local(2026, 6, 10, 9, 0) }), local(2026, 6, 10, 11, 0), watching),
    false
  )
  eq(
    'due again the next day',
    isDailyDue(mk({ lastRunAt: local(2026, 6, 10, 9, 0) }), local(2026, 6, 11, 9, 0), watching),
    true
  )
})

/* ── the case the brief called out ────────────────────────────────────────── */

describe('2. a laptop opened in the evening does not fire the morning')
withTz('America/New_York', () => {
  const watching = local(2026, 6, 10, 18, 0) // app opened at 18:00
  eq(
    '09:00 is not fired at 18:00 — the run was missed, and stays missed',
    isDailyDue(mk(), local(2026, 6, 10, 18, 0), watching),
    false
  )
  eq(
    'nor later that evening',
    isDailyDue(mk(), local(2026, 6, 10, 23, 30), watching),
    false
  )
  eq(
    'but it does fire the next morning',
    isDailyDue(mk(), local(2026, 6, 11, 9, 0), watching),
    true
  )

  const five = [
    mk({ id: 'a', trigger: { kind: 'daily', at: '07:00' } }),
    mk({ id: 'b', trigger: { kind: 'daily', at: '08:00' } }),
    mk({ id: 'c', trigger: { kind: 'daily', at: '09:00' } }),
    mk({ id: 'd', trigger: { kind: 'daily', at: '10:00' } }),
    mk({ id: 'e', trigger: { kind: 'daily', at: '11:00' } })
  ]
  eq(
    'five missed automations do not all run at once',
    dueAutomations(five, local(2026, 6, 10, 18, 0), watching).length,
    0
  )
})

/* ── midnight ─────────────────────────────────────────────────────────────── */

describe('3. midnight rollover on a long-running app')
withTz('America/New_York', () => {
  const watching = local(2026, 6, 10, 8, 0)
  const ranYesterday = mk({
    trigger: { kind: 'daily', at: '00:05' },
    lastRunAt: local(2026, 6, 10, 0, 5)
  })
  eq(
    'just before midnight it is not due',
    isDailyDue(ranYesterday, local(2026, 6, 10, 23, 59), watching),
    false
  )
  eq(
    'at 00:05 the next day it is',
    isDailyDue(ranYesterday, local(2026, 6, 11, 0, 5), watching),
    true
  )
  eq(
    'a run at 23:59 and one at 00:01 are different days',
    isSameLocalDay(local(2026, 6, 10, 23, 59), local(2026, 6, 11, 0, 1)),
    false
  )
})

/* ── the two days a year that are not 24 hours ────────────────────────────── */

describe('4. DST — spring forward (America/New_York, 2026-03-08)')
withTz('America/New_York', () => {
  // 09:00 must still mean 09:00 on a 23-hour day.
  const nine = scheduledOn(new Date(2026, 2, 8, 12, 0), '09:00')
  eq('09:00 on the short day is 09:00 by the clock', nine.getHours(), 9)

  // The bug this guards: midnight + 9h lands at 10:00 on a 23-hour day.
  const midnight = new Date(2026, 2, 8, 0, 0, 0, 0).getTime()
  const naive = new Date(midnight + 9 * 3600_000)
  ok(
    'naive midnight-plus-milliseconds would have been an hour out',
    naive.getHours() === 10,
    `naive arithmetic gave ${naive.getHours()}:00`
  )

  // 02:30 does not exist that day; it must not vanish.
  const skipped = scheduledOn(new Date(2026, 2, 8, 12, 0), '02:30')
  ok(
    'a time inside the skipped hour is moved forward, not dropped',
    skipped !== null && skipped.getHours() === 3 && skipped.getMinutes() === 30,
    skipped ? skipped.toString() : 'null'
  )
  eq(
    'and it fires once that day',
    isDailyDue(
      mk({ trigger: { kind: 'daily', at: '02:30' } }),
      local(2026, 3, 8, 12, 0),
      local(2026, 3, 8, 1, 0)
    ),
    true
  )
})

describe('5. DST — fall back (America/New_York, 2026-11-01)')
withTz('America/New_York', () => {
  const nine = scheduledOn(new Date(2026, 10, 1, 12, 0), '09:00')
  eq('09:00 on the long day is 09:00 by the clock', nine.getHours(), 9)

  const midnight = new Date(2026, 10, 1, 0, 0, 0, 0).getTime()
  const naive = new Date(midnight + 9 * 3600_000)
  ok(
    'naive midnight-plus-milliseconds would have been out again',
    naive.getHours() !== 9,
    `naive arithmetic gave ${naive.getHours()}:00`
  )

  // 01:30 happens twice that morning. It must run on the first, not both.
  const first = scheduledOn(new Date(2026, 10, 1, 12, 0), '01:30').getTime()
  const second = first + 3600_000
  ok(
    'the repeated hour really is repeated',
    new Date(second).getHours() === 1 && new Date(second).getMinutes() === 30,
    new Date(second).toString()
  )
  const watching = local(2026, 11, 1, 0, 30)
  eq('it fires on the first 01:30', isDailyDue(mk({ trigger: { kind: 'daily', at: '01:30' } }), first, watching), true)
  eq(
    'and not again on the second',
    isDailyDue(
      mk({ trigger: { kind: 'daily', at: '01:30' }, lastRunAt: first }),
      second,
      watching
    ),
    false
  )
})

describe('6. DST is not a US-only problem (Europe/London, 2026-10-25)')
withTz('Europe/London', () => {
  const nine = scheduledOn(new Date(2026, 9, 25, 12, 0), '09:00')
  eq('09:00 the morning the clocks go back is still 09:00', nine.getHours(), 9)
  const springNine = scheduledOn(new Date(2026, 2, 29, 12, 0), '09:00')
  eq('and 09:00 the morning they go forward is too', springNine.getHours(), 9)
})

/* ── everything that must never fire ──────────────────────────────────────── */

describe('7. what is never due')
withTz('America/New_York', () => {
  const watching = local(2026, 6, 10, 0, 0)
  const now = local(2026, 6, 10, 12, 0)
  eq('a manual automation', isDailyDue(mk({ trigger: { kind: 'manual' } }), now, watching), false)
  eq('an onOpen automation', isDailyDue(mk({ trigger: { kind: 'onOpen' } }), now, watching), false)
  eq('one with no prompt', isDailyDue(mk({ prompt: '   ' }), now, watching), false)
  eq('one with no name', isDailyDue(mk({ name: '' }), now, watching), false)
  eq('one with no folder', isDailyDue(mk({ cwd: '' }), now, watching), false)
  eq(
    'one pointed at a plain shell, which would never read the prompt',
    isDailyDue(mk({ agentId: 'shell' }), now, watching),
    false
  )
  eq(
    'one with a nonsense time',
    isDailyDue(mk({ trigger: { kind: 'daily', at: '25:99' } }), now, watching),
    false
  )
  eq('scheduledOn refuses a nonsense time', scheduledOn(new Date(now), '9:00'), null)
})

/* ── onOpen matching ──────────────────────────────────────────────────────── */

describe('8. onOpen matches on the folder')
{
  const a = mk({ trigger: { kind: 'onOpen' } })
  eq('fires for its own folder', firesOnOpen(a, '/Users/me/app'), true)
  eq('not for another folder', firesOnOpen(a, '/Users/me/other'), false)
  eq('not for a trailing-slash near-miss', firesOnOpen(a, '/Users/me/app/'), false)
  eq('a daily automation never fires on open', firesOnOpen(mk(), '/Users/me/app'), false)
  eq(
    'an incomplete one does not fire on open either',
    firesOnOpen(mk({ trigger: { kind: 'onOpen' }, prompt: '' }), '/Users/me/app'),
    false
  )
}

/* ── done ─────────────────────────────────────────────────────────────────── */

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
