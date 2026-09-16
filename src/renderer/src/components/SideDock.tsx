import { useCallback, useEffect, useRef, useState } from 'react'
import { FileCode2, Files, GitBranch, Inbox, Wrench } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { useStore, type DockTab } from '../store/useStore'
import { terminals } from '../lib/terminals'
import { EditorPanel } from './EditorPanel'
import { FileTree } from './FileTree'
import { GitPanel } from './GitPanel'
import { TasksPanel } from './TasksPanel'
import { ToolsPanel } from './ToolsPanel'

const TABS: { id: DockTab; label: string; icon: typeof Files }[] = [
  { id: 'files', label: 'Files', icon: Files },
  { id: 'editor', label: 'Editor', icon: FileCode2 },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'work', label: 'Work', icon: Inbox },
  { id: 'tools', label: 'Tools', icon: Wrench }
]

export function SideDock({ workspace }: { workspace: Workspace | null }): React.JSX.Element {
  const tab = useStore((s) => s.dockTab)
  const width = useStore((s) => s.dockWidth)
  const setWidth = useStore((s) => s.setDockWidth)
  const setDockTab = useStore((s) => s.setDockTab)
  const home = useStore((s) => s.home)

  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onMove = useCallback(
    (e: MouseEvent) => {
      setWidth(startW.current + (startX.current - e.clientX))
    },
    [setWidth]
  )

  useEffect(() => {
    if (!dragging) return
    const onUp = (): void => {
      setDragging(false)
      terminals.fitAll()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [dragging, onMove])

  const cwd = workspace?.cwd ?? home

  return (
    <>
      <div
        className="dock-resizer"
        data-dragging={dragging}
        role="separator"
        aria-label="Resize side panel"
        onMouseDown={(e) => {
          startX.current = e.clientX
          startW.current = width
          setDragging(true)
        }}
      />
      <aside className="dock" style={{ width, flexBasis: width }}>
        <div className="dock-tabs">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                className="dock-tab"
                key={t.id}
                data-on={tab === t.id}
                title={t.label}
                onClick={() => setDockTab(t.id)}
              >
                <Icon size={14} />
                {t.label}
              </button>
            )
          })}
        </div>

        <div className="dock-body">
          {tab === 'files' && <FileTree cwd={cwd} key={cwd} />}
          {tab === 'editor' && (
            <EditorPanel cwd={cwd} workspaceId={workspace?.id} key={cwd} />
          )}
          {tab === 'git' && (
            <GitPanel cwd={cwd} host={workspace?.host} workspaceId={workspace?.id} key={cwd} />
          )}
          {tab === 'work' && <TasksPanel cwd={cwd} key={cwd} />}
          {tab === 'tools' && <ToolsPanel workspace={workspace} />}
        </div>
      </aside>
    </>
  )
}
