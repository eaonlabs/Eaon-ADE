import { Brain, ChevronDown, ClipboardList, Compass, Globe, SquareTerminal, Flame, GitBranch, LayoutList, Loader, NotebookPen, Plus, Terminal, X } from 'lucide-react'
import { PANEL_KINDS, isPanelKind, projectOf, type Workspace, type WorkspaceKind } from '@shared/types'
import type { SshHost } from '@shared/ssh'
import { useCallback, useEffect, useState } from 'react'
import { MOD, basename } from '../lib/util'
import { useStore } from '../store/useStore'

const GLYPH: Record<WorkspaceKind, typeof Terminal> = {
  terminals: Terminal,
  board: LayoutList,
  vault: NotebookPen,
  brain: Brain,
  stats: Flame,
  browser: Compass
}

/**
 * The app's own surfaces, at the right-hand end of the strip.
 *
 * Not tabs, and set apart from them: a tab is one of this project's working
 * places and you open and close as many as you like, while these four are
 * always exactly here. They sit in the strip rather than the rail because the
 * strip has room across where the rail only has room down, and because the
 * Brain belongs to a project — one per folder — so the strip, which is already
 * scoped to one project, is the only place a single Brain button can be honest.
 */
const PLACE_LABEL: Record<(typeof PANEL_KINDS)[number], string> = {
  board: 'Tasks',
  vault: 'Vault',
  brain: 'Brain',
  stats: 'Stats'
}

const PLACE_GLYPH: Record<(typeof PANEL_KINDS)[number], typeof Terminal> = {
  board: ClipboardList,
  vault: NotebookPen,
  brain: Brain,
  stats: Flame
}

/**
 * The branch the whole project is on.
 *
 * Project-wide on purpose, and placed beside the project's name rather than on
 * a tab: every tab of a project shares one folder, so they share one branch.
 * Switching here moves all of them at once, which is why the control sits with
 * the thing it actually belongs to.
 */
function ProjectBranch({ cwd, host }: { cwd: string; host: SshHost | null }): React.JSX.Element | null {
  const notify = useStore((s) => s.notify)
  const [current, setCurrent] = useState<string | null>(null)
  const [list, setList] = useState<string[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const read = useCallback((): void => {
    void window.eaon.git.branch(cwd, host).then(setCurrent)
  }, [cwd, host])

  useEffect(read, [read])

  // Re-read when a pane in this project finishes something: an agent that ran
  // `git switch` itself should not leave this control lying about where it is.
  useEffect(() => {
    const id = window.setInterval(read, 5000)
    return () => window.clearInterval(id)
  }, [read])

  if (!current) return null

  const pick = async (branch: string): Promise<void> => {
    setOpen(false)
    if (branch === current) return
    setBusy(true)
    try {
      const res = await window.eaon.git.switch(cwd, branch, host)
      // git's own refusal names the files that would be lost; it is worth far
      // more than a generic "could not switch".
      notify({
        kind: res.ok ? 'info' : 'error',
        title: res.ok ? `On ${branch}` : 'Could not switch branch',
        text: res.message
      })
      read()
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="ws-branch-wrap">
      <button
        className="ws-branch"
        disabled={busy}
        onClick={() => {
          setOpen((v) => !v)
          if (list === null) void window.eaon.git.branches(cwd, host).then(setList)
        }}
        title={`On ${current} — every tab of this project shares it`}
      >
        {busy ? <Loader size={10} className="spin" /> : <GitBranch size={10} />}
        <span className="ws-branch-name">{current}</span>
        <ChevronDown size={10} />
      </button>
      {open && (
        <>
          <span className="ws-branch-scrim" onClick={() => setOpen(false)} />
          <span className="ws-branch-menu">
            {list === null ? (
              <span className="ws-branch-note">Reading branches…</span>
            ) : list.length === 0 ? (
              <span className="ws-branch-note">No local branches.</span>
            ) : (
              list.map((b) => (
                <button key={b} className="ws-branch-item" data-on={b === current} onClick={() => void pick(b)}>
                  <GitBranch size={10} />
                  {b}
                </button>
              ))
            )}
          </span>
        </>
      )}
    </span>
  )
}

/**
 * The tabs of the project you are in.
 *
 * A tab belongs to a project and never spans two of them: the strip shows the
 * tabs of whichever project the active workspace is a tab of, and nothing
 * else. Switching project is the rail's job, not the strip's — a strip that
 * listed every workspace on the machine would be a second, worse rail.
 *
 * Tabs of one project cannot share files. The first tab works in the
 * repository itself; `openTab` cuts a git worktree on its own branch for each
 * one after it, so two agents in two tabs cannot overwrite each other.
 *
 * Deliberately not a replacement for the grid: a tab holds a whole workspace,
 * so the several panes inside one are still side by side. Tabs switch between
 * sets of agents; panes watch several at once.
 */
export function WorkspaceTabs(): React.JSX.Element | null {
  const workspaces = useStore((s) => s.workspaces)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const setActive = useStore((s) => s.setActiveWorkspace)
  const close = useStore((s) => s.closeWorkspace)
  const confirmClose = useStore((s) => s.settings.confirmClose)
  const openTab = useStore((s) => s.openTab)
  const notify = useStore((s) => s.notify)
  const notices = useStore((s) => s.notices)
  const showTabs = useStore((s) => s.settings.showWorkspaceTabs)
  const openPanel = useStore((s) => s.openPanel)
  const stagePage = useStore((s) => s.stagePage)
  const [opening, setOpening] = useState(false)
  const [adding, setAdding] = useState(false)
  const openBrowserTab = useStore((s) => s.openBrowserTab)

  const active = workspaces.find((w) => w.id === activeId)
  // Terminals and browsers are tabs of a project; the panels are not — they are
  // places, and they sit apart from the tabs on the right.
  const isTab = (k: WorkspaceKind): boolean => k === 'terminals' || k === 'browser'
  /*
   * The project the strip belongs to.
   *
   * A panel is not a tab, but it was opened *from* a project and remembers it,
   * so the strip stays put while you are on one rather than vanishing and
   * taking the way back with it.
   */
  const project = active ? projectOf(active) : null
  const tabs = project ? workspaces.filter((w) => isTab(w.kind) && projectOf(w) === project) : []
  // Lit only when the panel is what the stage is actually showing: a stage page
  // outranks the workspace, so during one nothing here is where you are.
  const here = !stagePage && active && isPanelKind(active.kind) ? active.kind : null

  if (!showTabs || !project) return null

  /*
   * Closing a tab ends the agents in it, so it asks first — the same question
   * the rail asks, under the same setting, because it is the same loss. The
   * close button sits a few pixels from the tab you click to switch to, which
   * is exactly where an accident happens.
   */
  const onClose = (w: Workspace): void => {
    if (confirmClose && w.panes.length > 0) {
      const n = w.panes.length
      const ok = window.confirm(
        `Close ${w.name}? ${n} session${n === 1 ? '' : 's'} will end.\n\n` +
          'You can bring it back with ⇧⌘T, or by opening a tab in this project.'
      )
      if (!ok) return
    }
    close(w.id)
  }

  const addTab = async (): Promise<void> => {
    if (!active) return
    setOpening(true)
    try {
      const res = await openTab(active.id)
      if (!res.ok) {
        notify({ kind: 'error', title: 'Could not open a tab', text: res.error ?? '' })
      }
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="ws-tabs" role="tablist" aria-label={`Tabs in ${basename(project)}`}>
      <span className="ws-tabs-project" title={project}>
        {basename(project)}
      </span>
      <ProjectBranch cwd={project} host={active?.host ?? null} />
      <div className="ws-tabs-scroll">
        {tabs.map((w) => {
          const Icon = GLYPH[w.kind] ?? Terminal
          const on = w.id === activeId
          // p.working, not status: status is live while you are merely typing.
          const working = w.kind === 'terminals' && w.panes.some((p) => p.working)
          const waiting = notices.some((n) => n.workspaceId === w.id && n.kind === 'attention')
          return (
            <div
              key={w.id}
              className={`ws-tab hue-${w.hue}`}
              data-on={on}
              data-working={working}
              data-waiting={waiting}
              role="tab"
              aria-selected={on}
            >
              <button className="ws-tab-face" onClick={() => setActive(w.id)} title={w.cwd}>
                <Icon size={13} />
                <span className="ws-tab-name">{w.name}</span>
                {w.panes.length > 1 && <span className="ws-tab-count">{w.panes.length}</span>}
              </button>
              <button
                className="ws-tab-close"
                onClick={() => onClose(w)}
                aria-label={`Close ${w.name}`}
                title={`Close ${w.name}`}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
      </div>
      <span className="ws-add-wrap">
        <button
          className="ws-tab-add"
          onClick={() => setAdding((v) => !v)}
          disabled={opening}
          aria-label="New tab in this project"
          title="New tab in this project"
        >
          {opening ? <Loader size={14} className="spin" /> : <Plus size={14} />}
        </button>
        {adding && (
          <>
            <span className="ws-add-scrim" onClick={() => setAdding(false)} />
            <span className="ws-add-menu">
              <button
                className="ws-add-item"
                onClick={() => {
                  setAdding(false)
                  void addTab()
                }}
              >
                <SquareTerminal size={13} />
                <span>Terminal</span>
                <kbd>{MOD}T</kbd>
              </button>
              <button
                className="ws-add-item"
                onClick={() => {
                  setAdding(false)
                  if (active) openBrowserTab(active.id)
                }}
              >
                <Globe size={13} />
                <span>Browser</span>
                <kbd>{MOD}⇧B</kbd>
              </button>
            </span>
          </>
        )}
      </span>

      <span className="ws-places">
        {PANEL_KINDS.map((kind) => {
          const Icon = PLACE_GLYPH[kind]
          return (
            <button
              key={kind}
              className="ws-place"
              data-on={here === kind}
              // The project, not the active workspace's own folder: a worktree
              // tab would otherwise open a second Brain for the same repo.
              onClick={() => openPanel(kind, project)}
              title={
                kind === 'brain'
                  ? `Brain for ${basename(project)}`
                  : `${PLACE_LABEL[kind]} — ${MOD}K to search everything`
              }
              aria-label={PLACE_LABEL[kind]}
              aria-current={here === kind ? 'page' : undefined}
            >
              <Icon size={14} />
            </button>
          )
        })}
      </span>

    </div>
  )
}
