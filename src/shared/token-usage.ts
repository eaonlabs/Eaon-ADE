/**
 * What every agent on this machine has spent, over a window you choose.
 *
 * Distinct from `usage.ts`, which answers "how much of the plan is left right
 * now" against a rolling five hours and seven days. This answers the other
 * question — what has been spent over the last week, month or quarter, by
 * model, by project, and day by day — and it is read from the same transcripts
 * rather than asked of anyone.
 *
 * Every number here is counted, not sampled. The one estimate is the money,
 * and it is labelled as one wherever it appears: a subscription does not bill
 * per token at all, so the dollar figure answers "what would this have cost
 * through the API" and never "what you owe".
 */

/** Windows the surface offers. Days, so the arithmetic is obvious. */
export type UsageRange = 7 | 30 | 90

export const USAGE_RANGES: UsageRange[] = [7, 30, 90]

/** The chart and the tables can both be read either way. */
export type UsageMetric = 'cost' | 'tokens'

export interface UsagePoint {
  /** Local YYYY-MM-DD. */
  date: string
  cost: number
  /** Everything: input, output, cache writes and cache reads. */
  tokens: number
}

export interface UsageModelRow {
  model: string
  label: string
  cost: number
  tokens: number
  requests: number
  /** Share of the window's cost, 0-100. */
  share: number
}

export interface UsageWorkspaceRow {
  /** The project folder the agent was working in, exactly as recorded. */
  path: string
  /** Its basename, which is what the row shows. */
  name: string
  cost: number
  tokens: number
  requests: number
}

/**
 * One row per tool whose logs this machine actually has.
 *
 * Deliberately not a fixed list of every agent the app can launch: a legend
 * naming four tools when three of them have never run here would be inventing
 * rows to fill a shape. Only what was found is reported.
 */
export interface UsageProviderRow {
  id: string
  label: string
  cost: number
  tokens: number
  /** Share of the window's cost, 0-100. */
  share: number
}

export interface TokenUsage {
  range: UsageRange
  /** Inclusive bounds of the window, local YYYY-MM-DD. */
  from: string
  to: string

  /** List-price estimate in USD across the window. */
  cost: number
  /** Everything counted: input + output + cache writes + cache reads. */
  tokens: number
  requests: number

  /** Read back out of the cache — the cheap part, and usually most of it. */
  cachedInput: number
  /** Share of everything sent in that came from the cache, 0-100. */
  cachedShare: number
  /** Fresh input, billed at full rate. */
  uncachedInput: number
  cacheWrite: number
  output: number

  /**
   * What the cache was worth, in dollars.
   *
   * Cache reads are billed at a tenth of fresh input or less. This is the
   * difference between what was paid for them and what the same tokens would
   * have cost arriving fresh — the number that says whether the caching is
   * doing anything.
   */
  cacheSavings: number
  /** What the bill would have been without the cache, as a multiple of it. */
  cacheMultiple: number

  days: UsagePoint[]
  models: UsageModelRow[]
  workspaces: UsageWorkspaceRow[]
  providers: UsageProviderRow[]
  /** Projects with any activity in the window, of which `workspaces` is a page. */
  workspaceCount: number

  /** How long the read took, so a slow scan is visible rather than mysterious. */
  tookMs: number
}

export const EMPTY_TOKEN_USAGE: TokenUsage = {
  range: 30,
  from: '',
  to: '',
  cost: 0,
  tokens: 0,
  requests: 0,
  cachedInput: 0,
  cachedShare: 0,
  uncachedInput: 0,
  cacheWrite: 0,
  output: 0,
  cacheSavings: 0,
  cacheMultiple: 0,
  days: [],
  models: [],
  workspaces: [],
  providers: [],
  workspaceCount: 0,
  tookMs: 0
}

/** 15,200,000,000 reads as 15.2B. Tokens only ever arrive in these sizes. */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`
  return `${(n / 1e9).toFixed(1)}B`
}

/**
 * Money, at the precision the size deserves.
 *
 * Thousands do not want cents — "$4,793.26" reads as false precision on a
 * figure that is an estimate to begin with — and cents matter below ten
 * dollars, where rounding to the nearest dollar would print "$0".
 */
export function money(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`
  if (n >= 10) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

/** "Sep 16" — the axis labels and the window caption share this. */
export function shortDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  if (!y || !m || !d) return key
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
