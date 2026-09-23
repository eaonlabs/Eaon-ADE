import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookText, FileText, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import type { DirEntry } from '@shared/types'
import { FilePreviewBody } from './FilePreviewBody'
import { basename } from '../lib/util'

/**
 * The repository's own markdown, read as documents.
 *
 * Deliberately not a third note-taking surface. The Vault holds scratch notes
 * this app owns, and the Brain holds linked memory the agents write over MCP —
 * both are things you author here. Pages is the opposite: prose that already
 * exists in the folder you are working in, written by whoever wrote the
 * project, and read rather than edited. A README, the docs directory, the
 * contributing guide. The editor is where you change one of these; this is
 * where you go to find out what the project says about itself.
 */

/** `fs.search` matches the needle anywhere in a filename, so `notes.mdx` and
 *  `changelog.md.bak` both come back for `.md`. Only these are documents. */
const DOC_EXT = new Set(['md', 'markdown'])

/**
 * `searchFiles` in fsapi.ts stops at 60 hits. Worth saying out loud when the
 * list is full rather than quietly showing part of a repository as if it were
 * all of it.
 */
const SEARCH_LIMIT = 60

interface Doc {
  path: string
  name: string
  /** Folder this sits in, relative to the workspace. '' for the top level. */
  dir: string
}

function toDoc(entry: DirEntry, cwd: string): Doc {
  const rel = entry.path.startsWith(cwd) ? entry.path.slice(cwd.length).replace(/^\//, '') : entry.path
  const cut = rel.lastIndexOf('/')
  return { path: entry.path, name: basename(entry.path), dir: cut === -1 ? '' : rel.slice(0, cut) }
}

/**
 * Front door first, then shallowest, then alphabetical.
 *
 * A repository has one document that is meant to be read before the others and
 * it is always called README. Sorting purely by path would bury it under
 * whatever `docs/architecture.md` sorts above, and the first thing this surface
 * shows would be an arbitrary one.
 */
function order(a: Doc, b: Doc): number {
  const front = (d: Doc): number => (d.dir === '' && /^readme\.(md|markdown)$/i.test(d.name) ? 0 : 1)
  const byFront = front(a) - front(b)
  if (byFront !== 0) return byFront

  const depth = (d: Doc): number => (d.dir === '' ? 0 : d.dir.split('/').length)
  const byDepth = depth(a) - depth(b)
  if (byDepth !== 0) return byDepth

  const byDir = a.dir.localeCompare(b.dir)
  return byDir !== 0 ? byDir : a.name.localeCompare(b.name)
}

export function PagesPage({ cwd }: { cwd: string }): React.JSX.Element {
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [capped, setCapped] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<Doc[]> => {
    if (!cwd) return []
    const hits = await window.eaon.fs.search(cwd, '.md')
    setCapped(hits.length >= SEARCH_LIMIT)
    return hits
      .filter((e) => !e.isDir && DOC_EXT.has(e.name.split('.').pop()?.toLowerCase() ?? ''))
      .map((e) => toDoc(e, cwd))
      .sort(order)
  }, [cwd])

  useEffect(() => {
    let live = true
    setDocs(null)
    setSelected(null)
    setQuery('')
    void load().then((found) => {
      if (!live) return
      setDocs(found)
      // Open the front door rather than an empty right-hand side.
      setSelected(found[0]?.path ?? null)
    })
    return () => {
      live = false
    }
  }, [load])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      const found = await load()
      setDocs(found)
      // Keep whatever was open if it is still there, so a refresh does not
      // throw away the reader's place.
      setSelected((was) => (was && found.some((d) => d.path === was) ? was : (found[0]?.path ?? null)))
    } finally {
      setBusy(false)
    }
  }

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle || !docs) return docs ?? []
    return docs.filter(
      (d) => d.name.toLowerCase().includes(needle) || d.dir.toLowerCase().includes(needle)
    )
  }, [docs, query])

  if (!cwd) {
    return (
      <div className="panel">
        <div className="empty" style={{ height: '100%' }}>
          <strong>No folder open.</strong>
          <span>Pages reads the markdown in the workspace you are in.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="panel pages">
      <div className="panel-bar">
        <div className="field">
          <Search size={13} color="var(--text-dim)" />
          <input
            value={query}
            placeholder="Find a page"
            spellCheck={false}
            aria-label="Find a page"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          className="icon-btn"
          onClick={() => void refresh()}
          disabled={busy}
          title="Look again"
          aria-label="Look for pages again"
        >
          <RefreshCw size={13} className={busy ? 'spin' : undefined} />
        </button>
      </div>

      {docs === null ? (
        <div className="empty" style={{ height: '100%' }}>
          <span className="eyebrow">Reading the folder…</span>
        </div>
      ) : docs.length === 0 ? (
        <div className="empty" style={{ height: '100%' }}>
          <BookText size={20} color="var(--text-dim)" />
          <strong>No markdown here.</strong>
          <span>A README, a docs folder or any .md file in this workspace turns up on this page.</span>
        </div>
      ) : (
        <div className="panel-split">
          <div className="panel-side">
            <div className="pages-head">
              <span className="eyebrow">Pages</span>
              <span className="pages-count">{shown.length}</span>
            </div>

            {shown.length === 0 ? (
              <p className="wk-note">Nothing matches “{query.trim()}”.</p>
            ) : (
              shown.map((doc) => (
                <button
                  key={doc.path}
                  className="pages-row"
                  data-on={doc.path === selected}
                  onClick={() => setSelected(doc.path)}
                  title={doc.dir ? `${doc.dir}/${doc.name}` : doc.name}
                >
                  <FileText size={12} />
                  <span className="pages-row-body">
                    <span className="pages-name">{doc.name}</span>
                    {doc.dir && <span className="pages-dir">{doc.dir}</span>}
                  </span>
                </button>
              ))
            )}

            {capped && (
              <p className="wk-note wk-note-warn">
                <TriangleAlert size={12} />
                Showing the first {SEARCH_LIMIT} found. This folder has more.
              </p>
            )}
          </div>

          <div className="panel-main">
            {selected ? (
              // The same wrapper the preview pane uses, so a long document
              // scrolls here exactly as it does there.
              <div className="fp-scroll">
                <FilePreviewBody path={selected} />
              </div>
            ) : (
              <div className="empty" style={{ height: '100%' }}>
                <span>Pick a page to read it.</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
