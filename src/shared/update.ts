/**
 * Auto-update state, shared between the main process and the renderer.
 *
 * The renderer never talks to the update server. It receives one of these and
 * draws it; every decision about what to fetch and when lives in main.
 */

export type UpdatePhase =
  | 'idle'
  /** A check is in flight. */
  | 'checking'
  /** Nothing newer than what is running. */
  | 'current'
  /** Newer version found, download starting or under way. */
  | 'downloading'
  /** Downloaded and staged; restarting will apply it. */
  | 'ready'
  /** Something went wrong. `error` says what. */
  | 'error'
  /** Updates cannot run in this build (unpackaged, no feed, or a distro package). */
  | 'unsupported'

export interface UpdateState {
  phase: UpdatePhase
  /** The version on offer, when there is one. */
  version: string | null
  /** Release notes as plain text, trimmed. Null when the release had none. */
  notes: string | null
  releaseDate: string | null
  /** 0–100 while downloading. */
  percent: number
  /** Bytes per second, for the download line. */
  bytesPerSecond: number
  transferred: number
  total: number
  error: string | null
  /** Epoch ms of the last completed check, for "checked just now". */
  lastCheckedAt: number | null
  /**
   * Why updating is unsupported, when there is something useful to say.
   *
   * Set for a Linux .deb or .rpm, where the answer is not "this build is
   * broken" but "your package manager owns this app" — which the user can act
   * on, and cannot guess.
   */
  unsupportedReason?: string | null
}

export const IDLE_UPDATE_STATE: UpdateState = {
  phase: 'idle',
  version: null,
  notes: null,
  releaseDate: null,
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
  error: null,
  lastCheckedAt: null
}

/** Release notes arrive as HTML from GitHub; the card wants readable text. */
export function notesToText(input: string | null | undefined, limit = 600): string | null {
  if (!input) return null
  const text = input
    .replace(/<\s*(br|\/p|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  if (!text) return null
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** "1.4 MB/s", "820 KB/s". */
export function formatRate(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond < 1) return ''
  const mb = bytesPerSecond / 1_000_000
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`
  return `${Math.round(bytesPerSecond / 1000)} KB/s`
}

export function formatSize(bytes: number): string {
  if (!bytes) return ''
  const mb = bytes / 1_000_000
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`
}
