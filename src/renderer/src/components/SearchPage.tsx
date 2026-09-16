import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Search, TriangleAlert, X } from 'lucide-react'
import type { GrepFileHits, GrepMatch, GrepResult } from '@shared/grep'
import { useStore } from '../store/useStore'

/**
 * Search, across the contents of the workspace rather than its filenames.
 *
 * The file tree already answers "what is this file called"; this answers "where
 * does this string appear", which is the question you actually have most of the
 * time. Results are grouped the way the answer is shaped — by file, then by
 * line — because twenty hits in one file is one fact, not twenty.
 *
 * Everything expensive happens in the main process: the walk, the reading, the
 * caps. This debounces, draws, and gets out of the way.
 */

/**
 * Long enough that the query is worth running.
 *
 * A search fires on its own here, so every keystroke is a potential walk of the
 * whole repository. Waiting a moment after typing stops means one search per
 * word instead of one per letter, and nobody perceives the pause because they
 * were still typing through it.
 */
const DEBOUNCE_MS = 220

/** `grepFiles` refuses below this; saying so beats an empty result. */
const MIN_QUERY = 2

function Line({ hit }: { hit: GrepMatch }): React.JSX.Element {
  // Offsets come from the main process already adjusted for any clipping it
  // did, so slicing here lands on the same characters it found.
  const before = hit.text.slice(0, hit.start)
  const match = hit.text.slice(hit.start, hit.end)
  const after = hit.text.slice(hit.end)
  return (
    <span className="sr-line">
      {before}
      <mark className="sr-mark">{match}</mark>
      {after}
    </span>
  )
}

export function SearchPage({ cwd }: { cwd: string }): React.JSX.Element {
  const openFile = useStore((s) => s.openFileInEditor)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<GrepResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  /**
   * Which search the answer on screen belongs to.
   *
   * Searches are started as you type and finish out of order — a one-letter
   * query walking the whole tree can easily land after the four-letter one that
   * replaced it. Stamping each run and ignoring anything but the newest is what
   * stops an old answer overwriting a newer one.
   */
  const run = useRef(0)

  const needle = query.trim()

  useEffect(() => {
    if (!cwd || needle.length < MIN_QUERY) {
      run.current += 1
      setResult(null)
      setBusy(false)
      setFailed(null)
      return
    }

    const mine = (run.current += 1)
    setBusy(true)
    const timer = setTimeout(() => {
      window.eaon.fs
        .grep(cwd, needle)
        .then((found) => {
          if (run.current !== mine) return
          setResult(found)
          setFailed(null)
        })
        .catch((err: unknown) => {
          if (run.current !== mine) return
          setResult(null)
          setFailed(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (run.current === mine) setBusy(false)
        })
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [cwd, needle])

  /** Path relative to the workspace — the absolute one is noise you already know. */
  const rel = useMemo(() => {
    const base = cwd.endsWith('/') ? cwd : `${cwd}/`
    return (p: string): string => (p.startsWith(base) ? p.slice(base.length) : p)
  }, [cwd])

  if (!cwd) {
    return (
      <div className="panel">
        <div className="empty" style={{ height: '100%' }}>
          <strong>No folder open.</strong>
          <span>Search looks inside the files of the workspace you are in.</span>
        </div>
      </div>
    )
  }

  const files: GrepFileHits[] = result?.files ?? []
  const capped = Boolean(result && (result.cappedHits || result.cappedFiles))

  return (
    <div className="panel search-page">
      <div className="panel-bar">
        <div className="field">
          <Search size={13} color="var(--text-dim)" />
          <input
            value={query}
            placeholder="Find in files"
            spellCheck={false}
            autoFocus
            aria-label="Find in files"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {query && (
            <button
              className="sr-clear"
              onClick={() => setQuery('')}
              title="Clear"
              aria-label="Clear the search"
            >
              <X size={12} />
            </button>
          )}
        </div>
        {result && !busy && (
          <span className="sr-count">
            {result.total === 0
              ? 'no matches'
              : `${result.total} ${result.total === 1 ? 'match' : 'matches'} in ${files.length} ${
                  files.length === 1 ? 'file' : 'files'
                }`}
          </span>
        )}
      </div>

      <div className="sr-scroll">
        {failed ? (
          <div className="empty" style={{ height: '100%' }}>
            <TriangleAlert size={20} color="var(--text-dim)" />
            <strong>That search didn’t finish.</strong>
            <span>{failed}</span>
          </div>
        ) : needle.length < MIN_QUERY ? (
          <div className="empty" style={{ height: '100%' }}>
            <Search size={20} color="var(--text-dim)" />
            <strong>Search this workspace.</strong>
            <span>
              Type at least {MIN_QUERY} characters. Matching is literal and ignores case — a
              bracket finds a bracket.
            </span>
          </div>
        ) : busy && !result ? (
          <div className="empty" style={{ height: '100%' }}>
            <span className="eyebrow">Searching…</span>
          </div>
        ) : files.length === 0 ? (
          <div className="empty" style={{ height: '100%' }}>
            <strong>Nothing matches “{needle}”.</strong>
            <span>Build folders, node_modules and .git aren’t searched.</span>
          </div>
        ) : (
          <div className="sr-list" data-stale={busy}>
            {files.map((file) => (
              <section className="sr-file" key={file.path}>
                <header className="sr-file-head" title={file.path}>
                  <FileText size={12} />
                  <span className="sr-file-name">{file.name}</span>
                  <span className="sr-file-dir">{rel(file.path)}</span>
                  <span className="sr-file-count">{file.hits.length}</span>
                </header>

                {file.hits.map((hit) => (
                  <button
                    className="sr-hit"
                    key={`${file.path}:${hit.line}:${hit.start}`}
                    onClick={() => openFile(file.path, hit.line)}
                    title={`Open ${file.name} at line ${hit.line}`}
                  >
                    <span className="sr-no">{hit.line}</span>
                    <Line hit={hit} />
                  </button>
                ))}
              </section>
            ))}

            {capped && (
              <p className="wk-note wk-note-warn sr-capped">
                <TriangleAlert size={12} />
                {result?.cappedFiles
                  ? 'Stopped after the first 50 files. There is more than this.'
                  : 'Stopped after the first 200 matches. There is more than this.'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
