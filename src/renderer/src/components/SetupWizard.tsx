import { useEffect, useState } from 'react'
import { Check, Folder, FolderOpen, Pencil, Plus, Server } from 'lucide-react'
import { LAYOUTS, gridShape, type AgentDef, type Preset } from '@shared/types'
import { useStore } from '../store/useStore'
import { basename, shortPath, uid } from '../lib/util'
import { AgentMark } from './AgentMarks'
import { HostPicker } from './HostPicker'
import { hostLabel } from '@shared/ssh'

const STEPS = ['Start', 'Layout', 'Agents'] as const

function TilePreview({ count }: { count: number }): React.JSX.Element {
  const { cols, rows } = gridShape(count)
  return (
    <span
      className="tile-preview"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      aria-hidden="true"
    >
      {Array.from({ length: cols * rows }, (_, i) => (
        <i className="tile-cell" key={i} style={{ opacity: i < count ? undefined : 0.12 }} />
      ))}
    </span>
  )
}

function MiniGrid({ count }: { count: number }): React.JSX.Element {
  const { cols, rows } = gridShape(count)
  return (
    <span
      className="mini-grid"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      aria-hidden="true"
    >
      {Array.from({ length: cols * rows }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  )
}

export function SetupWizard(): React.JSX.Element | null {
  const draft = useStore((s) => s.wizard)
  const update = useStore((s) => s.updateWizard)
  const close = useStore((s) => s.closeWizard)
  const create = useStore((s) => s.createWorkspace)
  const createTrial = useStore((s) => s.createTrial)
  const notify = useStore((s) => s.notify)
  const [isolating, setIsolating] = useState(false)
  const recents = useStore((s) => s.recents)
  const presets = useStore((s) => s.presets)
  const agents = useStore((s) => s.agents)
  const home = useStore((s) => s.home)
  const setPresetEditor = useStore((s) => s.setPresetEditor)
  const savePreset = useStore((s) => s.savePreset)

  const [pathValid, setPathValid] = useState(true)
  const [remoteAgents, setRemoteAgents] = useState<AgentDef[] | null>(null)
  // Which panel step 0 shows. Separate from draft.host on purpose: the tab
  // has to stay on "Remote host" while the user is still picking or typing
  // one — tying it to draft.host directly meant the picker could never
  // appear in the first place, since nothing sets a host by clicking the tab.
  const [showRemote, setShowRemote] = useState(false)

  useEffect(() => {
    // Which CLIs are on PATH is a question about whichever machine is about
    // to run them — checked fresh per host rather than assumed from this
    // machine's own answer, which would be wrong in both directions.
    if (!draft?.host) {
      setRemoteAgents(null)
      return
    }
    let live = true
    window.eaon.agents.detectRemote(draft.host).then((list) => live && setRemoteAgents(list))
    return () => {
      live = false
    }
  }, [draft?.host])

  useEffect(() => {
    // A remote path cannot be checked against the local filesystem — there is
    // no folder browser for it in this version, so it is taken on trust the
    // same way typing an unusual local path is: the workspace still opens,
    // and a wrong path just means an empty first `cd` in the pane.
    if (!draft?.cwd || draft.host) {
      setPathValid(true)
      return
    }
    let live = true
    window.eaon.fs.isDir(draft.cwd).then((ok) => live && setPathValid(ok))
    return () => {
      live = false
    }
  }, [draft?.cwd, draft?.host])

  if (!draft) return null

  const { cols, rows } = gridShape(draft.layout)

  const browse = async (): Promise<void> => {
    const picked = await window.eaon.fs.pickFolder(draft.cwd)
    if (picked) update({ cwd: picked })
  }

  const applyPreset = (p: Preset): void => {
    update({ layout: p.layout, agentId: p.agentId, prompt: p.prompt ?? '', presetId: p.id, cwd: p.cwd ?? draft.cwd })
  }

  const saveAsPreset = (): void => {
    const name = window.prompt('Name this preset', `${basename(draft.cwd)} ${draft.layout}`)
    if (!name) return
    savePreset({
      id: uid('pre_'),
      name,
      layout: draft.layout,
      agentId: draft.agentId,
      cwd: draft.cwd,
      prompt: draft.prompt || undefined
    })
  }

  const next = async (): Promise<void> => {
    if (draft.step < 2) {
      update({ step: (draft.step + 1) as 0 | 1 | 2 })
      return
    }
    if (!draft.isolate) {
      create(draft)
      return
    }
    // Cutting worktrees takes a moment and can fail — the folder may not be a
    // repository — so the wizard stays put and says so rather than closing on
    // a workspace that was never made.
    setIsolating(true)
    try {
      const res = await createTrial(draft)
      if (!res.ok) {
        notify({ kind: 'error', title: 'Could not isolate the run', text: res.error ?? 'Unknown error.' })
      }
    } finally {
      setIsolating(false)
    }
  }

  const canAdvance =
    draft.step === 0
      ? showRemote
        ? // A host has to actually be chosen — draft.cwd can still be holding
          // whatever local path the wizard opened with, from before the tab
          // was switched, which is not a fact about the remote box at all.
          Boolean(draft.host) && Boolean(draft.cwd)
        : Boolean(draft.cwd) && pathValid
      : true

  return (
    <div className="surface-scroll">
      <div className="surface-inner">
        <div className="stepper">
          {STEPS.map((label, i) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center' }}>
              {i > 0 && <span className="step-rule" data-done={draft.step >= i} />}
              <button
                className="step"
                data-state={draft.step === i ? 'current' : draft.step > i ? 'done' : 'todo'}
                onClick={() => draft.step > i && update({ step: i as 0 | 1 | 2 })}
              >
                <span className="step-num">{draft.step > i ? <Check size={11} /> : i + 1}</span>
                {label}
              </button>
            </div>
          ))}
        </div>

        {draft.step === 0 && (
          <>
            <div className="wizard-head">
              <h1 className="wizard-title">Where are you working?</h1>
              <p className="wizard-sub">
                {draft.host
                  ? 'Every terminal in this workspace runs on that box over ssh.'
                  : 'Every terminal in this workspace starts in this folder.'}
              </p>
            </div>

            <div className="loc-toggle" role="tablist" aria-label="Local or remote">
              <button
                role="tab"
                aria-selected={!showRemote}
                data-on={!showRemote}
                onClick={() => {
                  setShowRemote(false)
                  // A host picked while looking at this tab a moment ago
                  // should not silently make a "local" workspace remote.
                  if (draft.host) update({ host: null, cwd: '' })
                }}
              >
                <Folder size={13} />
                This machine
              </button>
              <button
                role="tab"
                aria-selected={showRemote}
                data-on={showRemote}
                onClick={() => setShowRemote(true)}
              >
                <Server size={13} />
                Remote host
              </button>
            </div>

            {!showRemote ? (
              <>
                <div className="section">
                  <div
                    className="field"
                    style={{ borderColor: pathValid ? undefined : 'var(--danger)' }}
                  >
                    <Folder size={15} color="var(--text-dim)" />
                    <input
                      value={draft.cwd}
                      spellCheck={false}
                      onChange={(e) => update({ cwd: e.target.value })}
                      placeholder="/Users/you/projects/thing"
                      aria-label="Working folder"
                    />
                    <button className="btn btn-ghost" style={{ height: 28 }} onClick={browse}>
                      <FolderOpen size={14} />
                      Browse
                    </button>
                  </div>
                  {!pathValid && (
                    <p className="section-note" style={{ color: 'var(--danger)', marginTop: 8 }}>
                      That folder does not exist. Pick another one.
                    </p>
                  )}
                </div>

                {recents.length > 0 && (
                  <div className="section">
                    <div className="section-head">
                      <span className="eyebrow">Recent</span>
                      <span className="section-note">{recents.length} folders</span>
                    </div>
                    <div className="card-grid">
                      {recents.map((r) => (
                        <button
                          className="folder-card"
                          key={r.path}
                          data-on={r.path === draft.cwd}
                          onClick={() => update({ cwd: r.path })}
                        >
                          <Folder size={16} />
                          <span className="folder-text">
                            <span className="folder-name">{r.name}</span>
                            <span className="folder-path">{shortPath(r.path, home)}</span>
                          </span>
                          {r.sessions > 0 && <span className="chip">{r.sessions}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <HostPicker
                host={draft.host}
                remotePath={draft.cwd}
                onHost={(h) => update({ host: h, cwd: draft.cwd })}
                onPath={(p) => update({ cwd: p })}
              />
            )}
          </>
        )}

        {draft.step === 1 && (
          <>
            <div className="wizard-head">
              <h1 className="wizard-title">How many terminals?</h1>
              <p className="wizard-sub">Pick a tile. You can add or close panes later.</p>
            </div>

            <div className="section">
              <div className="section-head">
                <span className="eyebrow">Layout</span>
                <div className="section-right">
                  <span className="chip" style={{ color: 'var(--accent)' }}>
                    {draft.layout} terminal{draft.layout === 1 ? '' : 's'}
                  </span>
                  <span className="section-note">
                    {cols}×{rows} grid
                  </span>
                </div>
              </div>
              <div className="layout-tiles">
                {LAYOUTS.map((n) => (
                  <button
                    className="layout-tile"
                    key={n}
                    data-on={draft.layout === n}
                    onClick={() => update({ layout: n })}
                    aria-label={`${n} terminals`}
                  >
                    <TilePreview count={n} />
                    <span className="layout-tile-n">{n}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="section">
              <div className="section-head">
                <span className="eyebrow">Presets</span>
                <span className="section-note">{presets.length} saved</span>
                <div className="section-right">
                  <button className="btn btn-ghost" style={{ height: 26 }} onClick={saveAsPreset}>
                    Save current
                  </button>
                </div>
              </div>
              <div className="preset-row">
                {presets.map((p) => (
                  <span className="preset-chip" key={p.id} data-on={draft.presetId === p.id}>
                    <MiniGrid count={p.layout} />
                    <button onClick={() => applyPreset(p)} style={{ color: 'inherit' }}>
                      {p.name}
                    </button>
                    <span
                      className="preset-edit"
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit ${p.name}`}
                      onClick={() => setPresetEditor(p.id)}
                      onKeyDown={(e) => e.key === 'Enter' && setPresetEditor(p.id)}
                    >
                      <Pencil size={11} />
                    </span>
                  </span>
                ))}
                <button className="preset-chip preset-chip-new" onClick={() => setPresetEditor('new')}>
                  <Plus size={12} />
                  New preset
                </button>
              </div>
            </div>
          </>
        )}

        {draft.step === 2 && (
          <>
            <div className="wizard-head">
              <h1 className="wizard-title">Which agent runs in each pane?</h1>
              <p className="wizard-sub">
                Eaon ADE types the command into a fresh shell. Anything greyed out is not on{' '}
                {draft.host ? `${hostLabel(draft.host)}'s PATH.` : 'your PATH.'}
              </p>
            </div>

            <div className="section">
              <div className="agent-list">
                {/*
                 * PATH is a property of whichever machine is about to run the
                 * command, so a remote workspace checks the remote host, not
                 * this one — reusing the local `available` flags here would
                 * grey out a CLI that only happens to be missing on this Mac,
                 * or wrongly offer one that is not actually on the far end.
                 * While that check is in flight, nothing is greyed out yet
                 * rather than guessing.
                 */}
                {(draft.host
                  ? (remoteAgents ?? agents.map((a) => ({ ...a, available: true })))
                  : agents
                ).map((a) => (
                  <button
                    className="agent-row"
                    key={a.id}
                    data-on={draft.agentId === a.id}
                    disabled={a.available === false}
                    onClick={() => update({ agentId: a.id })}
                  >
                    <span className="agent-mark">
                      {/*
                        The CLI's own mark, not a terminal glyph for all of
                        them. Every row looked identical, so the list could
                        only be read by name — and the pane header these rows
                        lead to has always shown the real one, which made the
                        picker the odd one out. `AgentMark` falls back to a
                        terminal for `shell`, which is the one row where a
                        terminal is the honest answer.
                      */}
                      <AgentMark agentId={a.id} size={16} />
                    </span>
                    <span className="agent-meta">
                      <span className="agent-name">{a.label}</span>
                      <span className="agent-blurb">
                        {a.available === false ? `${a.bin} not found on PATH` : a.blurb}
                      </span>
                    </span>
                    {a.bin && <span className="chip mono">{a.bin}</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="section">
              <div className="section-head">
                <span className="eyebrow">Opening prompt</span>
                <span className="section-note">
                  {draft.mode === 'swarm'
                    ? 'Sent to every pane once the agents are up.'
                    : 'Optional. Sent to every pane once the agents are up.'}
                </span>
              </div>
              <textarea
                className="prompt-box"
                value={draft.prompt}
                onChange={(e) => update({ prompt: e.target.value })}
                placeholder={
                  draft.mode === 'swarm'
                    ? 'Find every place we still call the v1 endpoint and propose a migration.'
                    : 'Leave blank to start each agent with an empty prompt.'
                }
              />
            </div>

            {/*
              * Isolation only means anything with more than one pane and a real
              * agent: one attempt has nothing to be compared against, and a
              * bare shell is not competing with anybody.
              */}
            {draft.layout > 1 && draft.agentId !== 'shell' && (
              <div className="section">
                <div className="section-head">
                  <span className="eyebrow">Isolation</span>
                  <span className="section-note">Uses git worktrees</span>
                </div>
                <label className="iso-toggle" data-on={draft.isolate}>
                  <input
                    type="checkbox"
                    checked={draft.isolate}
                    onChange={(e) => update({ isolate: e.target.checked })}
                  />
                  <span className="iso-body">
                    <span className="iso-name">Give each agent its own checkout</span>
                    <span className="iso-note">
                      {draft.layout} branches cut from this one, so the agents cannot overwrite
                      each other. Compare what each changed afterwards and merge the one you want.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </>
        )}

        <div className="wizard-foot">
          <button
            className="btn btn-ghost"
            onClick={() => (draft.step === 0 ? close() : update({ step: (draft.step - 1) as 0 | 1 | 2 }))}
          >
            {draft.step === 0 ? 'Cancel' : 'Back'}
          </button>
          <span className="spacer" />
          {draft.step === 2 && (
            <button
              className="btn"
              onClick={() => create({ ...draft, agentId: 'shell', prompt: '' })}
            >
              Open without agents
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={() => void next()}
            disabled={!canAdvance || isolating}
          >
            {isolating
              ? 'Cutting worktrees…'
              : draft.step === 2
                ? draft.isolate
                  ? 'Start the trial'
                  : 'Open workspace'
                : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
