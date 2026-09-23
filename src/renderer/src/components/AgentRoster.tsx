import React, { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { relTime, rosterFor, stateLabel, summarise, type AgentState } from '@shared/roster'
import { AgentMark, agentShortName } from './AgentMarks'
import { useStore } from '../store/useStore'

/**
 * How often the elapsed column is recomputed.
 *
 * The numbers are whole minutes, so anything faster redraws the rail to print
 * the same string. A minute late on "5m" costs nothing; a timer per row would
 * cost a render per second per agent.
 */
const TICK_MS = 30_000

/** The dot at the head of a row, which is the state in one character. */
function StateDot({ state }: { state: AgentState }): React.JSX.Element {
  return <span className="ros-dot" data-state={state} aria-hidden="true" />
}

/**
 * The agents inside one workspace, under its row in the rail.
 *
 * Collapsed by default. A workspace with four agents in it is four more rows
 * in a list you navigate by shape, and the chip carries the part you actually
 * scan for — how many, and whether any of them wants you.
 */
export function AgentRoster({
  workspace,
  open,
  onToggle,
  nested
}: {
  workspace: Workspace
  open: boolean
  onToggle: () => void
  nested: boolean
}): React.JSX.Element | null {
  const setActive = useStore((s) => s.setActiveWorkspace)
  const focusPane = useStore((s) => s.focusPane)

  /*
   * Re-read the clock rather than the panes. `now` is the only thing that
   * moves while nothing happens, and the entries themselves come from the
   * store, so an agent starting work still redraws immediately.
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(t)
  }, [open])

  const entries = rosterFor(workspace.panes, now)
  const { count, state } = summarise(entries)

  // Nothing to say about a workspace with no agents in it. The pane count on
  // the row above already covers a workspace that is only shells.
  if (count === 0) return null

  return (
    <div className="ros" data-nested={nested} data-open={open}>
      <button
        className="ros-head"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? 'Hide the agents' : 'Show the agents'}
      >
        <StateDot state={state ?? 'idle'} />
        {open ? (
          <span className="ros-title">
            {count} {count === 1 ? 'agent' : 'agents'}
          </span>
        ) : (
          <>
            {/* Shut, the marks are the content: which agents, at a glance. */}
            <span className="ros-marks">
              {entries.slice(0, 3).map((e) => (
                <span className="ros-mini" key={e.paneId}>
                  <AgentMark agentId={e.agentId} size={11} />
                </span>
              ))}
            </span>
            <span className="ros-title">
              {entries.length > 3 ? `+${entries.length - 3}` : ''}
            </span>
          </>
        )}
        <span className="ros-chev" aria-hidden="true">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>

      {open && (
        <ul className="ros-list">
          {entries.map((e) => (
            <li key={e.paneId}>
              <button
                className="ros-row"
                data-state={e.state}
                // The pane, not just the workspace: with four Claudes in a
                // grid, naming which one is the whole point of the list.
                onClick={() => {
                  setActive(workspace.id)
                  focusPane(workspace.id, e.paneId)
                }}
                title={`${e.name} — ${stateLabel(e.state)}`}
              >
                <StateDot state={e.state} />
                <span className="ros-mark">
                  <AgentMark agentId={e.agentId} size={12} />
                </span>
                <span className="ros-name">{agentShortName(e.agentId)}</span>
                <span className="ros-state">{stateLabel(e.state)}</span>
                <span className="ros-when">
                  {e.sinceMs === null ? 'now' : relTime(e.sinceMs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
