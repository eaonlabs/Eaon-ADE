/**
 * Searching inside files — the shape of an answer.
 *
 * Here rather than in `fsapi.ts` for the same reason every other feature in
 * this folder has a file: the main process produces this, the preload bridge
 * declares it, and the renderer draws it. One definition all three agree on
 * beats three that drift.
 */

export interface GrepMatch {
  /** 1-based, the way every editor and every `file:line` reference counts. */
  line: number
  text: string
  /** Where the match sits within `text`, for highlighting. */
  start: number
  end: number
}

export interface GrepFileHits {
  path: string
  name: string
  hits: GrepMatch[]
}

export interface GrepResult {
  files: GrepFileHits[]
  total: number
  /** The search stopped early: there are more matches than these. */
  cappedHits: boolean
  /** The search stopped early: there are more *files* than these. */
  cappedFiles: boolean
  /** Which backend answered. Surfaced so a surprising result can be explained. */
  tool: 'ripgrep' | 'walk'
}
