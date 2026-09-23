import { paneKind, type PaneSpec } from './types'

/**
 * What an agent in a workspace is doing.
 *
 * Deliberately four states rather than the pane's own `PaneStatus`. `status`
 * answers "did bytes arrive", which is true on every keystroke you type into
 * a prompt, and `working` answers "is something running" without saying
 * whether it stopped because it finished or because it wants you. The roster
 * is read at a glance from across the rail, so it needs the difference.
 */
export type AgentState = 'attention' | 'working' | 'exited' | 'idle'

export interface RosterEntry {
  paneId: string
  agentId: string
  /** The pane's own handle — "Tate", "Ava" — which is how you address it. */
  name: string
  state: AgentState
  /**
   * How long the pane has been in this state, in milliseconds.
   *
   * Null while it is working, where the honest answer is "still going" rather
   * than any elapsed number — an agent three seconds into a long run and one
   * three minutes in are both simply working.
   */
  sinceMs: number | null
}

/**
 * Whether this pane is an agent at all.
 *
 * A preview or a diff pane has no process to be busy, and a bare shell is not
 * an agent — counting either would make "3 agents" mean "3 panes", which the
 * pane count beside the workspace name already says.
 */
export function isAgentPane(pane: PaneSpec): boolean {
  return paneKind(pane) === 'terminal' && pane.agentId !== 'shell'
}

/**
 * The state a pane is in.
 *
 * Order matters: a pane that has exited is not working whatever its last
 * `working` value was, and an agent that rang the bell wants you even if it
 * is technically still running something.
 */
export function stateOf(pane: PaneSpec): AgentState {
  if (pane.status === 'exited') return 'exited'
  if (pane.status === 'attention') return 'attention'
  return pane.working ? 'working' : 'idle'
}

/**
 * When this pane last changed what it was doing.
 *
 * `lastActiveAt` is stamped on the transitions themselves, so for an idle
 * pane the gap since then is exactly how long it has been idle. It is absent
 * on a pane that has not moved since it was made, and on anything restored
 * from a state file written before the field existed — `createdAt` is the
 * right answer in both cases, because a pane that has never done anything has
 * been idle since it opened.
 */
export function sinceOf(pane: PaneSpec, now: number): number {
  return Math.max(0, now - (pane.lastActiveAt ?? pane.createdAt))
}

/**
 * The agents in one workspace, in the order their panes sit on the stage.
 *
 * Not sorted by state, tempting as it is to float the busy one to the top. The
 * rail is read next to the grid it describes, and a list that reorders itself
 * every time an agent starts or stops costs you the one thing that makes it
 * quick to use: row three is always the third pane.
 */
export function rosterFor(panes: PaneSpec[], now: number): RosterEntry[] {
  return panes.filter(isAgentPane).map((pane) => {
    const state = stateOf(pane)
    return {
      paneId: pane.id,
      agentId: pane.agentId,
      name: pane.name,
      state,
      sinceMs: state === 'working' ? null : sinceOf(pane, now)
    }
  })
}

/**
 * The one line the collapsed chip has room for.
 *
 * `state` is the loudest thing any agent in there is doing, so a shut roster
 * still says a pane wants you. Same precedence as the expanded list reads
 * top to bottom, so opening it never contradicts what the chip just said.
 */
export function summarise(entries: RosterEntry[]): {
  count: number
  state: AgentState | null
} {
  if (entries.length === 0) return { count: 0, state: null }
  const rank: AgentState[] = ['attention', 'working', 'exited', 'idle']
  let best = rank.length - 1
  for (const e of entries) best = Math.min(best, rank.indexOf(e.state))
  return { count: entries.length, state: rank[best] }
}

/**
 * A duration in the width of a rail.
 *
 * Whole units only, and never rounded up: "1h" on something that stopped
 * fifty-nine minutes ago would be a lie in the direction that matters, since
 * the number is there to tell you how stale the answer is.
 */
export function relTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** What the row says this agent is doing. */
export function stateLabel(state: AgentState): string {
  if (state === 'attention') return 'Needs you'
  if (state === 'working') return 'Working'
  if (state === 'exited') return 'Exited'
  return 'Idle'
}
