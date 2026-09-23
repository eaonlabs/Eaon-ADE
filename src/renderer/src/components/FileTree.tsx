import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, File, Folder, RefreshCw, Search, X } from 'lucide-react'
import type { DirEntry } from '@shared/types'
import { useStore } from '../store/useStore'

/**
 * The project, as a tree you can open a branch at a time.
 *
 * `EditorPanel` browses one directory at a time — you descend into a folder
 * and the list replaces itself. That is the right shape for "open this file",
 * and the wrong one for "where does this live", which is the question a tree
 * answers: several branches open at once, the shape of the project visible in
 * one glance.
 *
 * Children are fetched the first time a folder is opened and then kept, so
 * collapsing and reopening costs nothing. Nothing is walked up front: a tree
 * that eagerly recursed a home directory would sit there listing node_modules
 * for a minute before drawing anything.
 */

const INDENT = 11

function Node({
  entry,
  depth,
  open,
  children,
  selected,
  onToggle,
  onOpen
}: {
  entry: DirEntry
  depth: number
  open: boolean
  children: DirEntry[] | undefined
  selected: string | null
  onToggle: (entry: DirEntry) => void
  onOpen: (entry: DirEntry) => void
}): React.JSX.Element {
  return (
    <>
      <button
        className="ft-row"
        data-on={selected === entry.path}
        style={{ paddingLeft: 6 + depth * INDENT }}
        title={entry.path}
        onClick={() => (entry.isDir ? onToggle(entry) : onOpen(entry))}
      >
        <span className="ft-twist" data-open={open} data-dir={entry.isDir}>
          {entry.isDir ? <ChevronRight size={11} /> : null}
        </span>
        <span className="ft-icon">
          {entry.isDir ? <Folder size={12} /> : <File size={12} />}
        </span>
        <span className="ft-name">{entry.name}</span>
      </button>
      {open &&
        children?.map((child) => (
          <NodeBranch
            key={child.path}
            entry={child}
            depth={depth + 1}
            selected={selected}
            onOpen={onOpen}
          />
        ))}
    </>
  )
}

/** A folder owns its own open/children state, so opening one costs one call. */
function NodeBranch({
  entry,
  depth,
  selected,
  onOpen
}: {
  entry: DirEntry
  depth: number
  selected: string | null
  onOpen: (entry: DirEntry) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | undefined>(undefined)

  const toggle = useCallback(
    (e: DirEntry): void => {
      setOpen((was) => !was)
      if (children === undefined) {
        window.eaon.fs
          .list(e.path)
          .then(setChildren)
          .catch(() => setChildren([]))
      }
    },
    [children]
  )

  return (
    <Node
      entry={entry}
      depth={depth}
      open={open}
      children={children}
      selected={selected}
      onToggle={toggle}
      onOpen={onOpen}
    />
  )
}

export function FileTree({ cwd }: { cwd: string }): React.JSX.Element {
  const openFile = useStore((s) => s.openFileInEditor)
  const [roots, setRoots] = useState<DirEntry[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<DirEntry[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback((): void => {
    window.eaon.fs
      .list(cwd)
      .then(setRoots)
      .catch(() => setRoots([]))
  }, [cwd])

  useEffect(load, [load])

  // Debounced, because this walks the project and the field is typed into.
  useEffect(() => {
    if (!query.trim()) {
      setHits(null)
      return
    }
    const id = window.setTimeout(() => {
      window.eaon.fs.search(cwd, query).then(setHits).catch(() => setHits([]))
    }, 220)
    return () => window.clearTimeout(id)
  }, [query, cwd])

  const open = (entry: DirEntry): void => {
    setSelected(entry.path)
    openFile(entry.path)
  }

  return (
    <div className="panel ft-panel">
      <div className="panel-bar">
        <span className="field ft-field">
          <Search size={12} />
          <input
            value={query}
            placeholder="Search files"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search files"
          />
          {query && (
            <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => setQuery('')} aria-label="Clear">
              <X size={11} />
            </button>
          )}
        </span>
        <button className="icon-btn" onClick={load} aria-label="Refresh" title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="ft-scroll">
        {hits ? (
          hits.length === 0 ? (
            <p className="wk-note">Nothing matching “{query}”.</p>
          ) : (
            hits.map((h) => (
              <button
                key={h.path}
                className="ft-row"
                data-on={selected === h.path}
                style={{ paddingLeft: 8 }}
                title={h.path}
                onClick={() => open(h)}
              >
                <span className="ft-icon">
                  {h.isDir ? <Folder size={12} /> : <File size={12} />}
                </span>
                <span className="ft-name">{h.name}</span>
                {/* Where it was found matters as much as what was found. */}
                <span className="ft-where">{h.path.startsWith(cwd) ? h.path.slice(cwd.length + 1) : h.path}</span>
              </button>
            ))
          )
        ) : roots.length === 0 ? (
          <p className="wk-note">Nothing here.</p>
        ) : (
          roots.map((entry) => (
            <NodeBranch key={entry.path} entry={entry} depth={0} selected={selected} onOpen={open} />
          ))
        )}
      </div>
    </div>
  )
}
