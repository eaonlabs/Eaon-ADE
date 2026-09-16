import { useEffect, useRef, useState } from 'react'
import {
  Brain,
  ChevronRight,
  Compass,
  Clock,
  Command,
  FileText,
  Flame,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  LayoutList,
  NotebookPen,
  GitPullRequest,
  Layers,
  Pencil,
  Plus,
  Search,
  Square,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import {
  isPanelKind,
  projectOf,
  type Workspace,
  type WorkspaceFolder,
  type WorkspaceKind
} from '@shared/types'
import { useStore } from '../store/useStore'
import { MOD, basename } from '../lib/util'

/** The glyph that says what a workspace is, at a glance, in the rail. */
const GLYPH: Record<WorkspaceKind, typeof Terminal> = {
  terminals: Terminal,
  board: LayoutList,
  vault: NotebookPen,
  brain: Brain,
  stats: Flame,
  browser: Compass
}

/**
 * The nine cells of the working indicator.
 *
 * Eaon's mark is a letter A drawn on a grid of rounded squares with one cell
 * lit; this is that idea in motion — the same grid, with the light going round
 * it. Nine is the smallest grid that still reads as one, rather than as a row
 * of dots that could belong to anything.
 */
const PULSE_CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8]

/** The MIME type the rail's own drags carry, so a file from Finder is ignored. */
const DRAG_TYPE = 'application/x-eaon-workspace'

/** What the right-click menu is open on, and where it was opened. */
type MenuTarget = { kind: 'workspace' | 'folder'; id: string; x: number; y: number } | null

/** What is being renamed in place, if anything. */
type Editing = { kind: 'workspace' | 'folder'; id: string } | null

/**
 * A name you can type over, in the row where the name already was.
 *
 * In place rather than in a dialog: renaming is a correction, and a modal for a
 * correction costs more attention than the correction is worth. Escape puts the
 * old name back, so there is nothing to undo.
 */
function NameInput({
  value,
  onCommit,
  onCancel
}: {
  value: string
  onCommit: (next: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  // Blur fires on the way out of a committed or cancelled edit too; without
  // this, Escape would be immediately undone by the blur handler saving.
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    commit ? onCommit(draft) : onCancel()
  }

  return (
    <input
      ref={ref}
      className="ws-rename"
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      // The row underneath is a button: without these, typing a space would
      // press it and clicking to place the caret would switch workspace.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
      aria-label="Name"
    />
  )
}

export function WorkspaceRail(): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const folders = useStore((s) => s.folders)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const notices = useStore((s) => s.notices)
  const setActive = useStore((s) => s.setActiveWorkspace)
  const closeWorkspace = useStore((s) => s.closeWorkspace)
  const stopWorkspace = useStore((s) => s.stopWorkspace)
  const renameWorkspace = useStore((s) => s.renameWorkspace)
  const createFolder = useStore((s) => s.createFolder)
  const renameFolder = useStore((s) => s.renameFolder)
  const deleteFolder = useStore((s) => s.deleteFolder)
  const toggleFolder = useStore((s) => s.toggleFolder)
  const moveToFolder = useStore((s) => s.moveToFolder)
  const openWizard = useStore((s) => s.openWizard)
  const stagePage = useStore((s) => s.stagePage)
  const setStagePage = useStore((s) => s.setStagePage)
  const setPalette = useStore((s) => s.setPalette)
  const setResumeOpen = useStore((s) => s.setResumeOpen)
  const confirmClose = useStore((s) => s.settings.confirmClose)

  const [menu, setMenu] = useState<MenuTarget>(null)
  const [editing, setEditing] = useState<Editing>(null)
  /** Folder id the pointer is over mid-drag, or 'root' for the top level. */
  const [dropOn, setDropOn] = useState<string | null>(null)

  // The list is projects and nothing else. A panel is a destination in the nav
  // above, and a browser is a *tab* of a project, in the strip above the stage.
  const shells = workspaces.filter((w) => w.kind === 'terminals')
  const loose = shells.filter((w) => !w.folderId)

  const active = workspaces.find((w) => w.id === activeId) ?? null
  /*
   * Which panel the nav should light, if any.
   *
   * Read from the workspace you are actually in rather than from a mode of its
   * own, so the lit row and the stage cannot disagree — and `null` the moment a
   * stage page is showing, because a stage page outranks the workspace.
   */
  const activePanel = stagePage === null && active && isPanelKind(active.kind) ? active.kind : null

  // Any click elsewhere, Escape, or the window moving underneath it puts the
  // menu away — it is positioned in viewport coordinates and cannot follow.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const sessions = (w: Workspace): string =>
    `${w.panes.length} session${w.panes.length === 1 ? '' : 's'}`

  const onClose = (w: Workspace): void => {
    // Only a workspace with running shells is worth asking about; closing the
    // Board loses nothing, because its contents do not live in the workspace.
    if (confirmClose && w.panes.length > 0) {
      if (!window.confirm(`Close ${w.name}? ${sessions(w)} will end.`)) return
    }
    closeWorkspace(w.id)
  }

  const onStop = (w: Workspace): void => {
    // Asked about under the same setting as closing: both end running agents,
    // and that is the part worth a second of thought.
    if (confirmClose && w.panes.length > 0) {
      if (!window.confirm(`Stop ${sessions(w)} in ${w.name}? The workspace stays open.`)) return
    }
    stopWorkspace(w.id)
  }

  const openMenu = (e: React.MouseEvent, kind: 'workspace' | 'folder', id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ kind, id, x: e.clientX, y: e.clientY })
  }

  /** True when this drag started in the rail. */
  const isOurs = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(DRAG_TYPE)

  const glyph = (Icon: typeof Terminal, working: boolean, extra = ''): React.JSX.Element => (
    <span className={`ws-glyph ${extra}`.trim()} data-working={working}>
      <Icon size={15} />
      <span className="ws-pulse" aria-hidden="true">
        {PULSE_CELLS.map((i) => (
          <i key={i} />
        ))}
      </span>
    </span>
  )

  const item = (w: Workspace): React.JSX.Element => {
    const Icon = GLYPH[w.kind] ?? Terminal
    const attention = notices.filter((n) => n.workspaceId === w.id && n.kind === 'attention')
    const panel = w.kind !== 'terminals'
    const renaming = editing?.kind === 'workspace' && editing.id === w.id
    // p.working, not p.status === 'live': the latter is true while you type.
    const working = !panel && w.panes.some((p) => p.working)

    return (
      <button
        key={w.id}
        className={`ws-item hue-${w.hue}`}
        data-active={w.id === activeId}
        data-panel={panel}
        data-nested={!panel && Boolean(w.folderId)}
        // Only terminal workspaces are filed. The panels are one of each and
        // already have a section of their own; grouping them too would be the
        // same idea twice on one screen.
        draggable={!panel && !renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, w.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => setDropOn(null)}
        onClick={() => {
          if (!renaming) setActive(w.id)
        }}
        onContextMenu={(e) => openMenu(e, 'workspace', w.id)}
        title={renaming ? undefined : w.cwd}
        // The arc is decoration; this is how the same fact reaches a screen
        // reader, which cannot see something spin.
        aria-label={working ? `${w.name}, running` : undefined}
      >
        {glyph(Icon, working)}
        {renaming ? (
          <NameInput
            value={w.name}
            onCommit={(next) => {
              renameWorkspace(w.id, next)
              setEditing(null)
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <span className="ws-label">
            <span className="ws-name">{w.name}</span>
            {/* A panel says which project it is pointed at; a folder workspace is
                already named after its folder and would just repeat itself. */}
            {panel && <span className="ws-where">{basename(w.cwd) || w.cwd}</span>}
          </span>
        )}
        {!renaming && attention.length > 0 && (
          <span className="ws-attention">{attention.length}</span>
        )}
        {/*
          No close button on the row. It sat under the pointer on the way to
          every workspace you were only trying to switch to, and one slip ended
          however many agents were inside. Closing lives in the right-click menu
          now, where it takes a deliberate second click to reach.
        */}
        {!renaming && !panel && <span className="ws-count">{w.panes.length}</span>}
      </button>
    )
  }

  const folderRow = (f: WorkspaceFolder): React.JSX.Element => {
    const inside = shells.filter((w) => w.folderId === f.id)
    const renaming = editing?.kind === 'folder' && editing.id === f.id
    const Icon = f.collapsed ? Folder : FolderOpen
    // Folded shut, this is the only thing that says work is going on in there.
    const working = inside.some((w) => w.panes.some((p) => p.working))

    /* The whole group is the drop target, not just its header row — aiming at a
       28px strip to file something away is a worse gesture than aiming at the
       block it is going into, and a shut folder is only that strip. */
    const accept = {
      onDragOver: (e: React.DragEvent): void => {
        if (!isOurs(e)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setDropOn(f.id)
      },
      onDragLeave: (e: React.DragEvent): void => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropOn((d) => (d === f.id ? null : d))
      },
      onDrop: (e: React.DragEvent): void => {
        if (!isOurs(e)) return
        e.preventDefault()
        e.stopPropagation()
        setDropOn(null)
        moveToFolder(e.dataTransfer.getData(DRAG_TYPE), f.id)
      }
    }

    return (
      <div className="ws-folder" key={f.id} data-drop={dropOn === f.id} {...accept}>
        <button
          className="ws-item ws-folder-row"
          data-holding={inside.some((w) => w.id === activeId)}
          onClick={() => {
            if (!renaming) toggleFolder(f.id)
          }}
          onContextMenu={(e) => openMenu(e, 'folder', f.id)}
          aria-expanded={!f.collapsed}
          aria-label={working ? `${f.name}, running` : undefined}
        >
          <span className="ws-caret" data-open={!f.collapsed} aria-hidden="true">
            <ChevronRight size={13} />
          </span>
          {glyph(Icon, working, 'ws-folder-glyph')}
          {renaming ? (
            <NameInput
              value={f.name}
              onCommit={(next) => {
                renameFolder(f.id, next)
                setEditing(null)
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <span className="ws-name">{f.name}</span>
          )}
          {!renaming && <span className="ws-count">{inside.length}</span>}
        </button>

        {!f.collapsed && (
          <div className="ws-folder-body">
            {inside.length === 0 ? (
              <p className="ws-folder-empty">Drag a workspace here.</p>
            ) : (
              inside.map(item)
            )}
          </div>
        )}
      </div>
    )
  }

  const menuWorkspace = menu?.kind === 'workspace' ? workspaces.find((w) => w.id === menu.id) : null
  const menuFolder = menu?.kind === 'folder' ? folders.find((f) => f.id === menu.id) : null

  /*
   * The destinations, above the project list.
   *
   * Three of these are places that already existed and were only reachable by
   * a shortcut or a chip — Search was ⌘K and nothing else, Tasks was a Board
   * workspace you had to open and then close again. Naming them in the rail is
   * most of what the redesign is: the app could already do these, it just
   * never said so.
   */
  const dest = (
    key: string,
    label: string,
    Icon: typeof Terminal,
    on: boolean,
    go: () => void
  ): React.JSX.Element => (
    <button className="rail-dest" key={key} data-on={on} onClick={go}>
      <Icon size={15} />
      <span>{label}</span>
    </button>
  )

  return (
    <nav className="rail" aria-label="Workspaces">
      <button className="rail-new" onClick={() => openWizard('grid')} title={`New workspace (${MOD}T)`}>
        <span className="rail-new-glyph">
          <Plus size={14} />
        </span>
        New Workspace
      </button>

      {/*
        The stage pages, and only those.

        The panels — Tasks, Vault, Brain, Stats — are not here. They live in the
        strip above the stage, which has room across rather than down, and the
        Brain in particular belongs there: there is one per project, so a single
        row in a rail that spans every project could only ever be lying about
        three of them.
      */}
      <div className="rail-dests">
        {dest('search', 'Search', Search, stagePage === 'search', () => setStagePage('search'))}
        {dest('workspaces', 'Workspaces', Layers, stagePage === null && !activePanel, () => {
          setStagePage(null)
          // Leaving a panel means going back to the work, not just dropping a
          // stage page that was never showing. Back to *this* project's shell
          // where there is one — a panel knows the folder it was opened from.
          if (activePanel) {
            const here = projectOf({ cwd: active?.cwd ?? '', projectRoot: null })
            const back = shells.find((w) => projectOf(w) === here) ?? shells[0]
            if (back) setActive(back.id)
          }
        })}
        {dest('pulls', 'Pull requests', GitPullRequest, stagePage === 'pulls', () =>
          setStagePage('pulls')
        )}
        {dest('pages', 'Pages', FileText, stagePage === 'pages', () => setStagePage('pages'))}
        {dest('automations', 'Automations', Clock, stagePage === 'automations', () =>
          setStagePage('automations')
        )}
      </div>

      <div className="rail-head">
        <span className="eyebrow">Projects</span>
        <span className="rail-count">{shells.length}</span>
        <button
          className="icon-btn"
          onClick={() => setEditing({ kind: 'folder', id: createFolder() })}
          title="New folder"
          aria-label="New folder"
        >
          <FolderPlus size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={() => openWizard('grid')}
          title={`New workspace (${MOD}T)`}
          aria-label="New workspace"
        >
          <Plus size={15} />
        </button>
      </div>

      {/*
        The list is itself the target for "out of any folder", so putting a
        workspace back is the same gesture as filing it away — drag it to the
        open space rather than hunting for a command.
      */}
      <div
        className="rail-list"
        data-drop={dropOn === 'root'}
        onDragOver={(e) => {
          if (!isOurs(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDropOn('root')
        }}
        onDragLeave={(e) => {
          // Only when the pointer has actually left the list, not on the way
          // across one of the rows inside it.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDropOn((d) => (d === 'root' ? null : d))
        }}
        onDrop={(e) => {
          if (!isOurs(e)) return
          e.preventDefault()
          setDropOn(null)
          moveToFolder(e.dataTransfer.getData(DRAG_TYPE), null)
        }}
      >
        {shells.length === 0 && folders.length === 0 && (
          <p className="rail-empty">Nothing open yet. Start one with {MOD}T.</p>
        )}

        {folders.map(folderRow)}
        {loose.map(item)}
      </div>

      <div className="rail-foot">
        <button className="rail-action" onClick={() => setResumeOpen(true)}>
          <History size={14} />
          Resume a session
        </button>
        <button className="rail-action" onClick={() => setPalette(true)}>
          <Command size={14} />
          Commands
          <span className="kbd" style={{ marginLeft: 'auto' }}>
            {MOD}K
          </span>
        </button>
      </div>

      {menu && (menuWorkspace || menuFolder) && (
        <div
          className="rail-menu"
          style={{ top: menu.y, left: menu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
          {menuWorkspace && (
            <>
              <button
                className="menu-item"
                onClick={() => {
                  setEditing({ kind: 'workspace', id: menuWorkspace.id })
                  setMenu(null)
                }}
              >
                <Pencil size={13} />
                Rename
              </button>

              {menuWorkspace.kind === 'terminals' && (
                <>
                  <div className="menu-sep" />
                  {folders
                    .filter((f) => f.id !== menuWorkspace.folderId)
                    .map((f) => (
                      <button
                        className="menu-item"
                        key={f.id}
                        onClick={() => {
                          moveToFolder(menuWorkspace.id, f.id)
                          setMenu(null)
                        }}
                      >
                        <Folder size={13} />
                        Move to {f.name}
                      </button>
                    ))}
                  {menuWorkspace.folderId && (
                    <button
                      className="menu-item"
                      onClick={() => {
                        moveToFolder(menuWorkspace.id, null)
                        setMenu(null)
                      }}
                    >
                      <FolderOpen size={13} />
                      Move out of the folder
                    </button>
                  )}
                  <button
                    className="menu-item"
                    onClick={() => {
                      const id = createFolder(undefined, menuWorkspace.id)
                      setMenu(null)
                      setEditing({ kind: 'folder', id })
                    }}
                  >
                    <FolderPlus size={13} />
                    New folder with this
                  </button>
                </>
              )}

              <div className="menu-sep" />
              {/* Only when there is something running to stop. */}
              {menuWorkspace.kind === 'terminals' && menuWorkspace.panes.length > 0 && (
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenu(null)
                    onStop(menuWorkspace)
                  }}
                >
                  <Square size={13} />
                  Stop the sessions
                </button>
              )}
              <button
                className="menu-item"
                data-danger="true"
                onClick={() => {
                  setMenu(null)
                  onClose(menuWorkspace)
                }}
              >
                <X size={13} />
                Close workspace
              </button>
            </>
          )}

          {menuFolder && (
            <>
              <button
                className="menu-item"
                onClick={() => {
                  setEditing({ kind: 'folder', id: menuFolder.id })
                  setMenu(null)
                }}
              >
                <Pencil size={13} />
                Rename
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  toggleFolder(menuFolder.id)
                  setMenu(null)
                }}
              >
                {menuFolder.collapsed ? <FolderOpen size={13} /> : <Folder size={13} />}
                {menuFolder.collapsed ? 'Expand' : 'Collapse'}
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                data-danger="true"
                onClick={() => {
                  deleteFolder(menuFolder.id)
                  setMenu(null)
                }}
              >
                <Trash2 size={13} />
                Delete folder
              </button>
              {/* Said plainly, because the word "delete" next to a list of
                  running agents should never leave you guessing. */}
              <p className="rail-menu-note">Whatever is inside comes back out. Nothing closes.</p>
            </>
          )}
        </div>
      )}
    </nav>
  )
}
