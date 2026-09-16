import { useEffect, useRef, useState } from 'react'
import {
  ClipboardPaste,
  Copy,
  Eraser,
  GitBranch,
  LayoutGrid,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RotateCw,
  Search,
  SquarePlus,
  TextSelect,
  X
} from 'lucide-react'
import type { PaneSpec, Workspace } from '@shared/types'
import { useStore } from '../store/useStore'
import { terminals } from '../lib/terminals'
import { carriesFiles, lineFor, pathsFromDrop } from '../lib/drop'
import { branchOf } from '../lib/branch'
import { MOD } from '../lib/util'

/**
 * The drag payload's type, which is also how a pane recognises that what is
 * being dragged over it is another pane rather than a file from the desktop.
 * Dropping a file on a pane already means something else.
 */
/** Shared with SurfacePaneChrome — a preview or diff pane trades places with
 *  a terminal one through the exact same drag payload. */
export const PANE_DRAG = 'application/x-eaon-pane'

export function TerminalPane({
  workspace,
  pane,
  index,
  style,
  carrying = false,
  over = false,
  onCarry,
  onOver,
  onSwap
}: {
  workspace: Workspace
  pane: PaneSpec
  index: number
  /** Where the grid has placed this pane. Absent when it is zoomed alone. */
  style?: React.CSSProperties
  /** True while this is the pane being carried. */
  carrying?: boolean
  /** True while a carried pane is over this one and would trade places with it. */
  over?: boolean
  onCarry?: (paneId: string | null) => void
  onOver?: (paneId: string | null) => void
  /** Let go over another pane: the two trade places. */
  onSwap?: (dragId: string) => void
}): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const focusPane = useStore((s) => s.focusPane)
  const closePane = useStore((s) => s.closePane)
  const zoomPane = useStore((s) => s.zoomPane)
  const addPane = useStore((s) => s.addPane)
  const restartPane = useStore((s) => s.restartPane)
  const patchPane = useStore((s) => s.patchPane)
  const setGridTracks = useStore((s) => s.setGridTracks)

  const hostRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null)
  const [contextAt, setContextAt] = useState<{ x: number; y: number } | null>(null)
  // Counted, not a boolean: dragging over a child fires enter/leave in pairs,
  // and a single flag flickers off every time the pointer crosses one.
  const dragDepth = useRef(0)
  const [dropping, setDropping] = useState(false)

  const active = workspace.activePaneId === pane.id
  const zoomed = workspace.zoomedPaneId === pane.id

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    terminals.attach(pane.id, host, settings)
    terminals.spawn(
      pane.id,
      pane.cwd,
      {
        command: pane.command,
        agentId: pane.agentId,
        sessionId: pane.sessionId,
        host: workspace.host
      },
      settings
    )
    return () => terminals.detach(pane.id)
    // Settings changes are pushed through terminals.applySettings, not here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id])

  // Show the grid size briefly whenever it changes, the way a terminal does.
  useEffect(() => {
    let clear: number | null = null
    const off = terminals.onResize(pane.id, (cols, rows) => {
      setSize({ cols, rows })
      if (clear !== null) window.clearTimeout(clear)
      clear = window.setTimeout(() => setSize(null), 1100)
    })
    return () => {
      off()
      if (clear !== null) window.clearTimeout(clear)
    }
  }, [pane.id])

  /*
   * What the chip is showing, readable from inside the poll without the poll
   * depending on it.
   *
   * It used to be a plain dependency, and the poll is what changes it — so
   * every branch change tore the timer down, built another, and fired an
   * immediate extra `git` on the way through. A ref is read at the moment the
   * answer comes back, which is the value that actually matters.
   */
  const branchRef = useRef(pane.branch)
  branchRef.current = pane.branch

  // Branch chip. Goes through the shared cache, so a grid of panes over one
  // folder costs a single `git` call rather than one per pane.
  useEffect(() => {
    let live = true
    const read = (): void => {
      // Nothing here is worth doing behind another window.
      if (document.hidden) return
      branchOf(pane.cwd, workspace.host).then((b) => {
        if (live && b !== branchRef.current) patchPane(pane.id, { branch: b })
      })
    }
    read()
    const id = window.setInterval(read, 15000)
    document.addEventListener('visibilitychange', read)
    return () => {
      live = false
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', read)
    }
    // `workspace.host` decides which machine is asked, so a change to it has to
    // restart the poll. It survives a patchPane by reference, so naming it here
    // costs no extra teardowns.
  }, [pane.id, pane.cwd, workspace.host, patchPane])

  // ⌘F is caught by the app's shortcut layer, which cannot reach into a pane;
  // it names the pane instead and the pane opens its own search box.
  const findPaneId = useStore((s) => s.findPaneId)
  useEffect(() => {
    if (findPaneId !== pane.id) return
    setFindOpen(true)
    useStore.getState().setFindPane(null)
  }, [findPaneId, pane.id])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const contextUsed = pane.contextPct

  return (
    <section
      className="pane"
      style={style}
      data-active={active}
      data-status={pane.status}
      data-pane-id={pane.id}
      data-carrying={carrying}
      data-over={over}
      onMouseDown={() => {
        // Clicking an already-active pane must still put the caret back in it —
        // otherwise you come back from a dialog and cannot type.
        if (active) terminals.focus(pane.id)
        else focusPane(workspace.id, pane.id)
      }}
      aria-label={`Pane ${pane.name}`}
      data-dropping={dropping}
      onDragEnter={(e) => {
        if (!carriesFiles(e.dataTransfer)) return
        e.preventDefault()
        dragDepth.current += 1
        setDropping(true)
      }}
      onDragOver={(e) => {
        /*
         * Two different things can be dragged onto a pane and they mean
         * opposite things: another pane, which trades places with this one, and
         * files from the desktop, which are typed onto the prompt. The payload
         * says which, so the one place that has to tell them apart is here.
         */
        if (e.dataTransfer.types.includes(PANE_DRAG)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          onOver?.(pane.id)
          return
        }
        if (!carriesFiles(e.dataTransfer)) return
        // Without this the drop never fires and the window navigates instead.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        onOver?.(null)
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDropping(false)
      }}
      onDrop={(e) => {
        const carried = e.dataTransfer.getData(PANE_DRAG)
        if (carried) {
          e.preventDefault()
          e.stopPropagation()
          if (carried !== pane.id) onSwap?.(carried)
          onCarry?.(null)
          onOver?.(null)
          return
        }
        if (!carriesFiles(e.dataTransfer)) return
        e.preventDefault()
        e.stopPropagation()
        dragDepth.current = 0
        setDropping(false)
        const dt = e.dataTransfer
        void (async () => {
          const paths = await pathsFromDrop(dt)
          if (!paths.length) return
          focusPane(workspace.id, pane.id)
          // Typed onto the prompt and left there, like every other way text
          // arrives in this app — a path is only useful once you have said what
          // to do with it, so nothing is sent. The trailing space is what a
          // terminal leaves you, ready for the next word.
          terminals.paste(pane.id, `${lineFor(paths)} `)
          terminals.focus(pane.id)
        })()
      }}
    >
      {/*
        The header is the handle. Not the whole pane: the body is a terminal,
        where dragging selects text, and taking that away to move a window
        would cost far more than it gave.
      */}
      <header
        className="pane-head"
        draggable={Boolean(onCarry)}
        onDragStart={(e) => {
          e.dataTransfer.setData(PANE_DRAG, pane.id)
          e.dataTransfer.effectAllowed = 'move'
          onCarry?.(pane.id)
        }}
        onDragEnd={() => {
          onCarry?.(null)
          onOver?.(null)
        }}
        title="Drag to swap this pane with another"
      >
        <span className="pane-dot" />
        <span className="pane-index">{index + 1}</span>
        <span className="pane-label">
          <span className="pane-name">{pane.name}</span>
          {pane.title && <span className="pane-title">{pane.title}</span>}
        </span>

        {pane.branch && (
          <span className="chip pane-branch" title={`On branch ${pane.branch}`}>
            <GitBranch size={10} />
            {pane.branch}
          </span>
        )}

        {contextUsed !== null && (
          <span
            className="pane-context"
            data-low={contextUsed >= 80}
            title="Context used, read from the agent's own status line"
          >
            <span className="pane-context-bar">
              <span className="pane-context-fill" style={{ width: `${contextUsed}%` }} />
            </span>
            <span className="pane-context-num">{contextUsed}%</span>
          </span>
        )}

        <span className="pane-tools" ref={menuRef}>
          <button
            className="icon-btn"
            onClick={() => setMenuOpen((v) => !v)}
            title="Pane actions"
            aria-label="Pane actions"
          >
            <MoreHorizontal size={14} />
          </button>
          <button
            className="icon-btn"
            onClick={() => zoomPane(workspace.id, zoomed ? null : pane.id)}
            title={zoomed ? 'Back to grid' : 'Fill the grid'}
            aria-label={zoomed ? 'Back to grid' : 'Fill the grid'}
          >
            {zoomed ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            className="icon-btn"
            onClick={() => addPane(workspace.id, { agentId: pane.agentId })}
            title="Add a pane"
            aria-label="Add a pane"
          >
            <SquarePlus size={13} />
          </button>
          <button
            className="icon-btn pane-kill"
            onClick={() => closePane(workspace.id, pane.id)}
            title="Close pane"
            aria-label="Close pane"
          >
            <X size={13} />
          </button>

          {menuOpen && (
            <div className="pane-menu">
              <button
                className="menu-item"
                onClick={() => {
                  restartPane(pane.id)
                  setMenuOpen(false)
                }}
              >
                <RotateCw size={13} />
                Restart session
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  terminals.clear(pane.id)
                  setMenuOpen(false)
                }}
              >
                <Eraser size={13} />
                Clear screen
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setFindOpen(true)
                  setMenuOpen(false)
                }}
              >
                <Search size={13} />
                Find in output
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  const sel = terminals.selection(pane.id)
                  if (sel) navigator.clipboard.writeText(sel)
                  setMenuOpen(false)
                }}
              >
                <Copy size={13} />
                Copy selection
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                data-danger="true"
                onClick={() => {
                  closePane(workspace.id, pane.id)
                  setMenuOpen(false)
                }}
              >
                <X size={13} />
                Close pane
              </button>
            </div>
          )}
        </span>
      </header>

      <div
        className="pane-term"
        ref={hostRef}
        onContextMenu={(e) => {
          e.preventDefault()
          const box = e.currentTarget.getBoundingClientRect()
          setContextAt({ x: e.clientX - box.left, y: e.clientY - box.top })
        }}
      />

      {size && (
        <span className="pane-size" aria-hidden="true">
          {size.cols} × {size.rows}
        </span>
      )}

      {contextAt && (
        <>
          <div className="context-catcher" onMouseDown={() => setContextAt(null)} />
          <div className="pane-menu" style={{ top: contextAt.y + 44, left: contextAt.x, right: 'auto' }}>
            <button
              className="menu-item"
              onClick={() => {
                const sel = terminals.selection(pane.id)
                if (sel) navigator.clipboard.writeText(sel)
                setContextAt(null)
              }}
            >
              <Copy size={13} />
              Copy
              <span className="kbd">{MOD}C</span>
            </button>
            <button
              className="menu-item"
              onClick={async () => {
                setContextAt(null)
                const text = await navigator.clipboard.readText()
                terminals.paste(pane.id, text)
                terminals.focus(pane.id)
              }}
            >
              <ClipboardPaste size={13} />
              Paste
              <span className="kbd">{MOD}V</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                terminals.selectAll(pane.id)
                setContextAt(null)
              }}
            >
              <TextSelect size={13} />
              Select all
            </button>
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                setFindOpen(true)
                setContextAt(null)
              }}
            >
              <Search size={13} />
              Find in output
            </button>
            <button
              className="menu-item"
              onClick={() => {
                terminals.clear(pane.id)
                setContextAt(null)
              }}
            >
              <Eraser size={13} />
              Clear screen
            </button>
            {/*
              Undoes every divider in the workspace at once. Offered here rather
              than only on the dividers themselves because the moment you want
              it is when the layout has got away from you — and that is exactly
              when the divider you would have to find is the thin one squeezed
              into a corner.
            */}
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                setGridTracks(workspace.id, null)
                setContextAt(null)
                window.setTimeout(() => terminals.fitAll(), 0)
              }}
            >
              <LayoutGrid size={13} />
              Even out the panes
            </button>
          </div>
        </>
      )}

      {findOpen && (
        <div className="pane-find">
          <Search size={13} color="var(--text-dim)" />
          <input
            autoFocus
            value={query}
            placeholder="Find in output"
            onChange={(e) => {
              setQuery(e.target.value)
              terminals.find(pane.id, e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') terminals.find(pane.id, query, e.shiftKey)
              if (e.key === 'Escape') {
                terminals.clearFind(pane.id)
                setFindOpen(false)
                setQuery('')
              }
            }}
          />
          <button
            className="icon-btn"
            onClick={() => {
              terminals.clearFind(pane.id)
              setFindOpen(false)
              setQuery('')
            }}
            aria-label="Close find"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {pane.status === 'exited' && (
        <div className="pane-overlay">
          <p className="pane-overlay-msg">This session ended.</p>
          <button className="btn" onClick={() => restartPane(pane.id)}>
            <RotateCw size={14} />
            Start it again
          </button>
        </div>
      )}
    </section>
  )
}
