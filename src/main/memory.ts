import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import type { MemoryHeadroom, MemoryPressure } from '../shared/memory'

/**
 * How much room is left to start another agent in.
 *
 * This exists because of a failure that looks like a bug in the app and is
 * not: with dozens of agents running, opening one more tab made *other*
 * sessions exit. Nothing in the app killed them. The machine had run out —
 * measured while it was happening: 59 agent processes holding 6.5 GB, 125 MB
 * of free RAM, 17.7 GB compressed, and swap at 10.9 of 12 GB. A new agent
 * wants a couple of hundred megabytes, there is nowhere to put it, and the
 * kernel takes the memory back from somebody. The victim is whichever process
 * the OS picks, which is never the one you just started.
 *
 * So the app asks first. Refusing to spawn is a worse experience than spawning
 * and a far better one than losing an agent that was part way through
 * something, because the refusal is reversible and the kill is not.
 *
 * `os.freemem()` is not enough on its own here. On macOS it reports free pages
 * only, which sit near zero on a healthy machine as well as a dying one — the
 * OS is supposed to use the RAM. What separates the two is whether there is
 * anywhere left to *page out to*, which is the swap figure.
 */



/**
 * Thresholds, in megabytes.
 *
 * A Claude Code process on this machine measured between 113 MB and 353 MB
 * resident, so `critical` is set where there is not reliably room for one more
 * of them plus the shell around it.
 */
const CRITICAL_SWAP = 1536
const CRITICAL_FREE = 512
const TIGHT_SWAP = 3072
const TIGHT_FREE = 1024

/** Long enough to cost nothing, short enough that it is never stale advice. */
const FRESH_MS = 4000

let cached: { at: number; value: MemoryHeadroom } | null = null

/** /proc/meminfo, or null where it cannot be read. */
async function readMemInfo(): Promise<string | null> {
  try {
    return await fs.readFile('/proc/meminfo', 'utf8')
  } catch {
    // Not Linux, or a sandbox without /proc. The os.freemem() default stands.
    return null
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    // argv array, never a shell — the same rule as everywhere else here.
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

/** `vm_stat`, as megabytes per counter we care about. */
function parseVmStat(text: string): { freeMb: number; compressedMb: number } {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 4096)
  const pages = (label: string): number => {
    const m = text.match(new RegExp(`${label}:\\s+(\\d+)`))
    return m ? Number(m[1]) : 0
  }
  const mb = (n: number): number => Math.round((n * pageSize) / 1048576)
  return {
    // Speculative pages are cheap to reclaim, so they count as free.
    freeMb: mb(pages('Pages free') + pages('Pages speculative')),
    compressedMb: mb(pages('Pages occupied by compressor'))
  }
}

function parseSwap(text: string): { swapFreeMb: number; swapTotalMb: number } {
  const num = (label: string): number => {
    const m = text.match(new RegExp(`${label}\\s*=\\s*([\\d.]+)M`))
    return m ? Math.round(Number(m[1])) : 0
  }
  return { swapFreeMb: num('free'), swapTotalMb: num('total') }
}

/**
 * The rule, exported so the checks can drive it directly.
 *
 * A check that re-states these thresholds in its own file proves only that
 * somebody can copy four numbers; it passes happily while the real rule says
 * something else.
 */
/**
 * The three numbers that matter, from /proc/meminfo.
 *
 * `MemAvailable` rather than `MemFree`, and the distinction is the whole point
 * of reading this file instead of calling os.freemem(). Linux spends free RAM
 * on page cache, so MemFree — which is what os.freemem() returns — sits near
 * zero on a healthy machine just as it does on a dying one. MemAvailable is
 * the kernel's own estimate of what a new allocation could actually get
 * without swapping, cache it would evict included.
 *
 * Reading the wrong one made a 4 GB Raspberry Pi with gigabytes to spare
 * report critical pressure and refuse to open a single pane.
 *
 * Every value in the file is in kB regardless of the unit column.
 */
export function parseMemInfo(text: string): {
  freeMb: number
  swapFreeMb: number
  swapTotalMb: number
} {
  const field = (name: string): number => {
    const match = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)
    return match ? Math.round(Number(match[1]) / 1024) : 0
  }
  // Kernels before 3.14 have no MemAvailable. MemFree is a poor stand-in but
  // it is the only one those kernels offer.
  const available = /^MemAvailable:/m.test(text) ? field('MemAvailable') : field('MemFree')
  return {
    freeMb: available,
    swapFreeMb: field('SwapFree'),
    swapTotalMb: field('SwapTotal')
  }
}

export function pressureFor(
  freeMb: number,
  swapFreeMb: number,
  swapTotalMb: number
): MemoryPressure {
  /*
   * Both halves have to be short before this is called critical.
   *
   * Low free RAM on its own is the normal state of a healthy machine. Low swap
   * on its own is fine while there is still RAM to allocate from. It is the
   * pair that means the next allocation has nowhere to come from.
   */
  if (swapTotalMb <= 0) {
    // No swap configured: free RAM is the whole story.
    return freeMb < CRITICAL_FREE ? 'critical' : freeMb < TIGHT_FREE ? 'tight' : 'ok'
  }
  if (freeMb < CRITICAL_FREE && swapFreeMb < CRITICAL_SWAP) return 'critical'
  if (freeMb < TIGHT_FREE && swapFreeMb < TIGHT_SWAP) return 'tight'
  return 'ok'
}

function describe(h: Omit<MemoryHeadroom, 'note'>): string {
  if (h.pressure === 'ok') return ''
  const swap =
    h.swapTotalMb > 0 ? `, and ${h.swapFreeMb} MB of ${h.swapTotalMb} MB swap` : ''
  return `${h.freeMb} MB of memory free${swap}.`
}

export async function memoryHeadroom(): Promise<MemoryHeadroom> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.value

  let freeMb = Math.round(os.freemem() / 1048576)
  let compressedMb = 0
  let swapFreeMb = 0
  let swapTotalMb = 0

  if (process.platform === 'linux') {
    const text = await readMemInfo()
    if (text) {
      const parsed = parseMemInfo(text)
      freeMb = parsed.freeMb
      swapFreeMb = parsed.swapFreeMb
      swapTotalMb = parsed.swapTotalMb
    }
  } else if (process.platform === 'darwin') {
    const [vm, swap] = await Promise.all([run('vm_stat', []), run('sysctl', ['-n', 'vm.swapusage'])])
    if (vm) {
      const parsed = parseVmStat(vm)
      freeMb = parsed.freeMb
      compressedMb = parsed.compressedMb
    }
    if (swap) {
      const parsed = parseSwap(swap)
      swapFreeMb = parsed.swapFreeMb
      swapTotalMb = parsed.swapTotalMb
    }
  }

  const base = {
    freeMb,
    swapFreeMb,
    swapTotalMb,
    compressedMb,
    pressure: pressureFor(freeMb, swapFreeMb, swapTotalMb)
  }
  const value: MemoryHeadroom = { ...base, note: describe(base) }
  cached = { at: Date.now(), value }
  return value
}

/** Only for the checks; nothing in the app should need to forget this. */
export function resetMemoryCache(): void {
  cached = null
}
