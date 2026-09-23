import { useMemo, useState } from 'react'
import { Clock, DoorOpen, Folder, Hand, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import {
  TRIGGER_LABEL,
  isRunnable,
  triggerLabel,
  type Automation,
  type AutomationTrigger,
  type TriggerKind
} from '@shared/automations'
import { useStore } from '../store/useStore'
import { basename, relTime, uid } from '../lib/util'

/**
 * Automations — a saved prompt and what makes it run.
 *
 * Running one opens an ordinary workspace with a single pane and hands the
 * prompt to `createWorkspace`, which is the same path the setup wizard takes.
 * Nothing here talks to a shell directly: an automation is a launch worth
 * remembering, not a second way of starting agents.
 */

const TRIGGER_ICON: Record<TriggerKind, typeof Hand> = {
  manual: Hand,
  onOpen: DoorOpen,
  daily: Clock
}

function blank(cwd: string, agentId: string): Automation {
  return {
    id: uid('a_'),
    name: '',
    prompt: '',
    agentId,
    cwd,
    trigger: { kind: 'manual' },
    lastRunAt: null
  }
}

/** Keeps the time across a switch away from `daily` and back. */
function retrigger(current: AutomationTrigger, kind: TriggerKind): AutomationTrigger {
  if (kind !== 'daily') return { kind }
  return { kind: 'daily', at: current.kind === 'daily' ? current.at : '09:00' }
}

export function AutomationsPage(): React.JSX.Element {
  const automations = useStore((s) => s.automations)
  const saveAutomation = useStore((s) => s.saveAutomation)
  const deleteAutomation = useStore((s) => s.deleteAutomation)
  const runAutomation = useStore((s) => s.runAutomation)

  const agents = useStore((s) => s.agents)
  const home = useStore((s) => s.home)
  const recents = useStore((s) => s.recents)
  const notify = useStore((s) => s.notify)

  const [draft, setDraft] = useState<Automation | null>(null)

  // A prompt needs something that reads it, so a plain shell is not offered.
  const runners = useMemo(() => agents.filter((a) => a.id !== 'shell'), [agents])
  const defaultCwd = recents[0]?.path ?? home
  const defaultAgent = runners[0]?.id ?? 'claude'

  const run = (a: Automation): void => {
    // Through the store, so pressing Run and a trigger firing are the same act
    // — including stamping lastRunAt, which the daily schedule reads back.
    runAutomation(a)
    notify({ kind: 'info', title: 'Automation started', text: a.name })
  }

  const commit = (): void => {
    if (!draft || !isRunnable(draft)) return
    saveAutomation({ ...draft, name: draft.name.trim(), prompt: draft.prompt.trim() })
    setDraft(null)
  }

  return (
    <div className="panel automations">
      <div className="panel-bar">
        <span className="eyebrow">Automations</span>
        <span className="auto-count mono">
          {automations.length === 1 ? '1 saved' : `${automations.length} saved`}
        </span>
        <span className="auto-bar-spacer" />
        <button
          className="wk-btn wk-btn-primary"
          onClick={() => setDraft(blank(defaultCwd, defaultAgent))}
          disabled={Boolean(draft)}
        >
          <Plus size={12} />
          New automation
        </button>
      </div>

      <div className="auto-scroll">
        {draft && (
          <form
            className="auto-form"
            onSubmit={(e) => {
              e.preventDefault()
              commit()
            }}
          >
            <div className="auto-form-head">
              <span className="eyebrow">New automation</span>
              <button
                type="button"
                className="wk-btn"
                onClick={() => setDraft(null)}
                aria-label="Discard"
              >
                <X size={12} />
                Discard
              </button>
            </div>

            <label className="auto-field">
              <span className="auto-label">Name</span>
              <input
                className="wk-input"
                value={draft.name}
                autoFocus
                placeholder="Morning review"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>

            <label className="auto-field">
              <span className="auto-label">Prompt</span>
              <textarea
                className="prompt-box auto-prompt"
                value={draft.prompt}
                rows={4}
                placeholder="What should the agent do when this runs?"
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
            </label>

            <div className="auto-grid">
              <label className="auto-field">
                <span className="auto-label">Agent</span>
                <select
                  className="wk-select"
                  value={draft.agentId}
                  onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}
                >
                  {runners.map((a) => (
                    <option key={a.id} value={a.id} disabled={a.available === false}>
                      {a.label}
                      {a.available === false ? ' (not installed)' : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label className="auto-field">
                <span className="auto-label">Trigger</span>
                <select
                  className="wk-select"
                  value={draft.trigger.kind}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      trigger: retrigger(draft.trigger, e.target.value as TriggerKind)
                    })
                  }
                >
                  {(Object.keys(TRIGGER_LABEL) as TriggerKind[]).map((k) => (
                    <option key={k} value={k}>
                      {TRIGGER_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>

              {draft.trigger.kind === 'daily' && (
                <label className="auto-field">
                  <span className="auto-label">At</span>
                  <input
                    className="wk-input"
                    type="time"
                    value={draft.trigger.at}
                    onChange={(e) =>
                      setDraft({ ...draft, trigger: { kind: 'daily', at: e.target.value } })
                    }
                  />
                </label>
              )}
            </div>

            <label className="auto-field">
              <span className="auto-label">Folder</span>
              <div className="auto-folder">
                <input
                  className="wk-input mono"
                  value={draft.cwd}
                  spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                />
                <button
                  type="button"
                  className="wk-btn"
                  onClick={async () => {
                    const picked = await window.eaon.fs.pickFolder(draft.cwd || home)
                    if (picked) setDraft({ ...draft, cwd: picked })
                  }}
                >
                  <Folder size={12} />
                  Choose
                </button>
              </div>
            </label>

            <div className="auto-form-foot">
              <button className="wk-btn wk-btn-primary" type="submit" disabled={!isRunnable(draft)}>
                Save automation
              </button>
              {draft.trigger.kind !== 'manual' && (
                <span className="auto-hint">
                  Triggers are recorded but not fired yet — use Run for now.
                </span>
              )}
            </div>
          </form>
        )}

        {automations.length === 0 && !draft && (
          <div className="empty" style={{ paddingTop: 56 }}>
            <strong>No automations yet.</strong>
            <span>
              An automation is a prompt you keep — give it a folder and an agent, and it opens
              its own pane whenever you run it.
            </span>
          </div>
        )}

        {automations.map((a) => {
          const Icon = TRIGGER_ICON[a.trigger.kind]
          return (
            <div className="wk-row" key={a.id} data-tone={a.trigger.kind === 'manual' ? 'draft' : 'open'}>
              <span className="wk-icon" aria-hidden="true">
                <Icon size={13} />
              </span>

              <span className="wk-body">
                <span className="wk-title-line">
                  <span className="wk-title" title={a.name}>
                    {a.name}
                  </span>
                </span>
                <span className="wk-meta">
                  <span className="wk-state">{triggerLabel(a.trigger)}</span>
                  <span className="auto-cwd mono" title={a.cwd}>
                    {basename(a.cwd) || a.cwd}
                  </span>
                  <span>{a.lastRunAt ? `ran ${relTime(a.lastRunAt)}` : 'never run'}</span>
                </span>
              </span>

              <span className="wk-actions">
                <button className="wk-btn wk-btn-primary" onClick={() => run(a)} title="Run now">
                  <Play size={12} />
                  Run
                </button>
                <button
                  className="wk-btn"
                  onClick={() => setDraft(a)}
                  disabled={Boolean(draft)}
                  title="Edit"
                >
                  <Pencil size={12} />
                  Edit
                </button>
                <button
                  className="wk-btn"
                  onClick={() => deleteAutomation(a.id)}
                  title="Delete"
                  aria-label={`Delete ${a.name}`}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
