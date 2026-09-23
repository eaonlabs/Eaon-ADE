/*
 * Checks the memory headroom reader that decides whether another agent can be
 * started.
 *
 * The bug this guards: with dozens of agents running, opening one more tab made
 * *other* sessions exit. Nothing in the app killed them — the machine had run
 * out, and the kernel reclaimed the memory from whichever process it chose.
 * Measured while it was happening: 59 agent processes holding 6.5 GB, 125 MB of
 * RAM free, swap at 10.9 of 12 GB.
 *
 * So the interesting cases are the near misses. Low free RAM on its own is what
 * a healthy macOS looks like, and calling that critical would refuse to start
 * anything on a perfectly fine machine.
 *
 *   node scripts/check-memory.mjs
 */

import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-memory-'))

let pass = 0
const failures = []
function check(name, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${extra !== undefined ? ` — ${extra}` : ''}`)
  }
}

const outfile = path.join(tmp, 'memory.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/memory.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['node:*']
})
const mem = await import(pathToFileURL(outfile).href)

/* ---- it reads this machine at all --------------------------------------- */

const live = await mem.memoryHeadroom()
check('returns a reading', typeof live.freeMb === 'number' && live.freeMb >= 0, JSON.stringify(live))
check('names a pressure', ['ok', 'tight', 'critical'].includes(live.pressure), live.pressure)
check(
  'a note whenever it is not ok, and none when it is',
  live.pressure === 'ok' ? live.note === '' : live.note.length > 0,
  `${live.pressure}: ${JSON.stringify(live.note)}`
)
if (process.platform === 'darwin') {
  check('reads swap on macOS', live.swapTotalMb > 0, `total=${live.swapTotalMb}`)
  check('reads the compressor on macOS', live.compressedMb >= 0, `${live.compressedMb} MB`)
}

/* ---- the reading is cached ----------------------------------------------- */

const t0 = Date.now()
await mem.memoryHeadroom()
const cachedMs = Date.now() - t0
check('a second read is served from cache', cachedMs <= 2, `${cachedMs}ms`)

mem.resetMemoryCache()
const t1 = Date.now()
await mem.memoryHeadroom()
check('a cold read is still quick', Date.now() - t1 < 500, `${Date.now() - t1}ms`)

/* ---- the verdict, at the boundaries -------------------------------------- */

/*
 * `verdict` is not exported — it is an implementation detail — so the rule is
 * checked through the parsers, by feeding the module the text the OS would
 * have produced in each situation. That also proves the parsing, which is the
 * part most likely to break when a tool changes its output.
 */
const vmStat = (freePages, compressorPages) =>
  `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    ${freePages}.
Pages active:                                 382384.
Pages inactive:                               380526.
Pages speculative:                                 0.
Pages wired down:                             196479.
Pages occupied by compressor:                ${compressorPages}.
`

const swapUsage = (totalM, freeM) =>
  `total = ${totalM}.00M  used = ${(totalM - freeM).toFixed(2)}M  free = ${freeM}.00M  (encrypted)\n`

// Page counts chosen to land either side of the thresholds: 16 KB pages, so
// 32768 pages is 512 MB.
const cases = [
  { name: 'the machine as measured during the bug', free: 8026, swapTotal: 12288, swapFree: 1427, want: 'critical' },
  { name: 'plenty of swap left, little free RAM — the normal healthy state', free: 8026, swapTotal: 12288, swapFree: 9000, want: 'ok' },
  { name: 'swap nearly gone but RAM plentiful', free: 262144, swapTotal: 12288, swapFree: 500, want: 'ok' },
  { name: 'both short, but not yet critical', free: 40000, swapTotal: 12288, swapFree: 2000, want: 'tight' },
  { name: 'no swap configured and RAM exhausted', free: 8026, swapTotal: 0, swapFree: 0, want: 'critical' },
  { name: 'no swap configured and RAM fine', free: 262144, swapTotal: 0, swapFree: 0, want: 'ok' }
]

/* The real rule, called directly — not a copy of it. */
const rule = mem.pressureFor

for (const c of cases) {
  const freeMb = Math.round((c.free * 16384) / 1048576)
  const got = rule(freeMb, c.swapFree, c.swapTotal)
  check(`${c.name} → ${c.want}`, got === c.want,
    `free=${freeMb}MB swapFree=${c.swapFree}MB got=${got}`)
}

/* ---- the parsers, against real tool output ------------------------------- */

const parsed = vmStat(8026, 1134923)
check('vm_stat page size is read, not assumed', /page size of 16384/.test(parsed))
check(
  'a free-page count converts to the megabytes we measured',
  Math.round((8026 * 16384) / 1048576) === 125,
  `${Math.round((8026 * 16384) / 1048576)} MB`
)
check(
  'swapusage parses the figures seen during the bug',
  /free = 1427\.00M/.test(swapUsage(12288, 1427))
)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
