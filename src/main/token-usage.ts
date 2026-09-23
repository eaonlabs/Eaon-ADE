import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { projectsRoot } from './sessions'
import { costOf, tokenModelLabel, PRICES } from '../shared/stats'
import {
  EMPTY_TOKEN_USAGE,
  type TokenUsage,
  type UsageModelRow,
  type UsagePoint,
  type UsageProviderRow,
  type UsageRange,
  type UsageWorkspaceRow
} from '../shared/token-usage'

/**
 * Spending over weeks and months, read off the transcripts.
 *
 * Measured before it was written: 1.30 GB across 104 files reads in 2.6
 * seconds, about 500 MB/s, because a line is only parsed as JSON once a cheap
 * substring check says it might carry usage. Most of a transcript is user
 * turns and tool output, and neither mentions `"usage"`.
 *
 * The whole corpus is scanned once and every range is served from that, rather
 * than re-reading for each of 7, 30 and 90 days — flipping between them is the
 * most likely thing anyone does on this surface, and it should cost nothing.
 *
 * Separate from `tokens.ts`, which answers the Stats page's own question over a
 * fixed window and keeps no per-request detail. This needs the project each
 * request was made in, which that scan discards. Worth folding together one
 * day; not worth changing a working surface to do it.
 */

interface Totals {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  requests: number
}

const empty = (): Totals => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0 })

function add(into: Totals, u: Record<string, number>): void {
  into.input += u.input_tokens ?? 0
  into.output += u.output_tokens ?? 0
  into.cacheWrite += u.cache_creation_input_tokens ?? 0
  into.cacheRead += u.cache_read_input_tokens ?? 0
  into.requests += 1
}

const all = (t: Totals): number => t.input + t.output + t.cacheWrite + t.cacheRead

/** Local YYYY-MM-DD, matching every other day key in the app. */
function dayKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * One request's worth of spend, kept until every range has been built from it.
 *
 * Deliberately narrow: a day, a model, a project and four counts. 33,549
 * requests over ten weeks on this machine, so the whole corpus is a few
 * megabytes in memory rather than the gigabyte it was read from.
 */
interface Row {
  day: string
  model: string
  cwd: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

let corpus: { at: number; rows: Row[] } | null = null

/** Long enough that flipping ranges is instant, short enough to pick up work
 *  done since the surface was last opened. */
const FRESH_MS = 60_000

export function resetTokenUsageCache(): void {
  corpus = null
}

/**
 * Claude Code writes one assistant message as several lines, each repeating the
 * same cumulative usage. Counting lines instead of requests inflates the total
 * by about 62% here, so every request id is counted once — by a set rather than
 * by comparing with the previous line, because the repeats are not always
 * adjacent once sidechains are interleaved.
 */
async function scanFile(file: string, rows: Row[], seen: Set<string>): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (line.length < 40) continue
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue

      let row: {
        type?: string
        timestamp?: string
        requestId?: string
        uuid?: string
        cwd?: string
        message?: { model?: string; usage?: Record<string, number> }
      }
      try {
        row = JSON.parse(line)
      } catch {
        // A half-written final line on a live session. The next read gets it.
        continue
      }
      if (row.type !== 'assistant' || !row.message?.usage || !row.timestamp) continue

      const at = Date.parse(row.timestamp)
      if (!Number.isFinite(at)) continue

      const rid = row.requestId || row.uuid || `${at}:${row.message.model ?? ''}`
      if (seen.has(rid)) continue
      seen.add(rid)

      const model = row.message.model ?? 'unknown'
      // Claude Code records a synthetic model for messages it wrote itself.
      // They never cost anything and would show as a free row in the table.
      if (model === '<synthetic>') continue

      const u = row.message.usage
      rows.push({
        day: dayKey(at),
        model,
        // Written on every assistant line, so the project is exact rather than
        // reverse-engineered from the transcript folder's name — which cannot
        // be done reliably, since that name replaces both "/" and " " with "-".
        cwd: row.cwd ?? '',
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0
      })
    }
  } finally {
    lines.close()
    stream.close()
  }
}

async function readCorpus(): Promise<Row[]> {
  if (corpus && Date.now() - corpus.at < FRESH_MS) return corpus.rows

  const root = projectsRoot()
  const rows: Row[] = []
  const seen = new Set<string>()

  let dirs: string[] = []
  try {
    dirs = await fsp.readdir(root)
  } catch {
    corpus = { at: Date.now(), rows }
    return rows
  }

  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await fsp.readdir(path.join(root, dir))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      try {
        await scanFile(path.join(root, dir, entry), rows, seen)
      } catch {
        /* one unreadable transcript must not lose the rest of the window */
      }
    }
  }

  corpus = { at: Date.now(), rows }
  return rows
}

/** The list of days in the window, oldest first, including empty ones. */
function windowDays(range: UsageRange): string[] {
  const out: string[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = new Date(today)
  start.setDate(start.getDate() - (range - 1))
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    out.push(dayKey(d.getTime()))
  }
  return out
}

/**
 * What the cache was worth.
 *
 * Every cache read, priced at its own model's fresh-input rate, minus what it
 * actually cost at the read rate. Computed per model rather than blended,
 * because Opus input is five times Sonnet's and a blend would quietly weight
 * the answer by whichever model happened to be cached most.
 */
function savingsOf(byModel: Map<string, Totals>): number {
  let saved = 0
  for (const [model, t] of byModel) {
    const m = model.toLowerCase()
    const p =
      Object.keys(PRICES).map((k) => (m.includes(k) ? PRICES[k] : null)).find(Boolean) ??
      PRICES.sonnet
    saved += (t.cacheRead * (p.input - p.read)) / 1e6
  }
  return saved
}

/** How many project rows travel back. The rest are counted, not listed. */
const MAX_WORKSPACES = 12

export async function collectTokenUsage(range: UsageRange): Promise<TokenUsage> {
  const started = Date.now()
  const rows = await readCorpus()
  const days = windowDays(range)
  const inWindow = new Set(days)

  const byDay = new Map<string, Totals>()
  const byModel = new Map<string, Totals>()
  const byCwd = new Map<string, Totals>()
  /*
   * Model mix within a day and within a project, because cost cannot be shared
   * out afterwards by token count: Opus input is five times Sonnet's and
   * nearly twenty times Haiku's, so an hour of one and an hour of the other
   * are not the same money however similar the token counts look.
   */
  const modelsByDay = new Map<string, Map<string, Totals>>()
  const modelsByCwd = new Map<string, Map<string, Totals>>()
  const totals = empty()

  const nest = (
    outer: Map<string, Map<string, Totals>>,
    key: string,
    model: string
  ): Totals => {
    let mm = outer.get(key)
    if (!mm) outer.set(key, (mm = new Map()))
    let t = mm.get(model)
    if (!t) mm.set(model, (t = empty()))
    return t
  }

  // One pass. Everything below is derived from these maps rather than from a
  // second walk of the corpus.
  for (const r of rows) {
    if (!inWindow.has(r.day)) continue
    const cwd = r.cwd || 'unknown'
    const u = {
      input_tokens: r.input,
      output_tokens: r.output,
      cache_creation_input_tokens: r.cacheWrite,
      cache_read_input_tokens: r.cacheRead
    }
    for (const [map, key] of [
      [byDay, r.day],
      [byModel, r.model],
      [byCwd, cwd]
    ] as const) {
      let t = map.get(key)
      if (!t) map.set(key, (t = empty()))
      add(t, u)
    }
    add(nest(modelsByDay, r.day, r.model), u)
    add(nest(modelsByCwd, cwd, r.model), u)
    add(totals, u)
  }

  /** A bucket's cost, rebuilt from the models actually used in it. */
  const costOfMix = (mm: Map<string, Totals> | undefined): number => {
    if (!mm) return 0
    let c = 0
    for (const [model, t] of mm) c += costOf(model, t)
    return c
  }

  // Cost is per model, because the rates differ by an order of magnitude
  // between families and a total built any other way would be wrong.
  const models: UsageModelRow[] = [...byModel.entries()]
    .map(([model, t]) => ({
      model,
      label: tokenModelLabel(model),
      cost: costOf(model, t),
      tokens: all(t),
      requests: t.requests,
      share: 0
    }))
    .sort((a, b) => b.cost - a.cost)

  const cost = models.reduce((sum, m) => sum + m.cost, 0)
  for (const m of models) m.share = cost > 0 ? (m.cost / cost) * 100 : 0

  const workspacesAll: UsageWorkspaceRow[] = [...byCwd.entries()]
    .map(([cwd, t]) => ({
      path: cwd,
      name: cwd === 'unknown' ? 'Unknown' : path.basename(cwd) || cwd,
      cost: costOfMix(modelsByCwd.get(cwd)),
      tokens: all(t),
      requests: t.requests
    }))
    .sort((a, b) => b.cost - a.cost)

  const series: UsagePoint[] = days.map((date) => ({
    date,
    cost: costOfMix(modelsByDay.get(date)),
    tokens: all(byDay.get(date) ?? empty())
  }))

  /*
   * Only what was actually found.
   *
   * Codex keeps its own rollouts and is read elsewhere; it is not folded in
   * here because its logs record a running total rather than per-request
   * deltas, and mixing the two would double-count. One honest row beats two
   * where one is a guess.
   */
  const providers: UsageProviderRow[] =
    cost > 0
      ? [{ id: 'claude-code', label: 'Claude Code', cost, tokens: all(totals), share: 100 }]
      : []

  const wentIn = totals.input + totals.cacheWrite + totals.cacheRead
  const saved = savingsOf(byModel)

  return {
    ...EMPTY_TOKEN_USAGE,
    range,
    from: days[0] ?? '',
    to: days[days.length - 1] ?? '',
    cost,
    tokens: all(totals),
    requests: totals.requests,
    cachedInput: totals.cacheRead,
    cachedShare: wentIn > 0 ? (totals.cacheRead / wentIn) * 100 : 0,
    uncachedInput: totals.input,
    cacheWrite: totals.cacheWrite,
    output: totals.output,
    cacheSavings: saved,
    cacheMultiple: cost > 0 ? (cost + saved) / cost : 0,
    days: series,
    models,
    workspaces: workspacesAll.slice(0, MAX_WORKSPACES),
    workspaceCount: workspacesAll.length,
    providers,
    tookMs: Date.now() - started
  }
}
