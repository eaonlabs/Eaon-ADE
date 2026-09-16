import { useCallback, useEffect, useState } from 'react'
import { Check, GitBranch, GitCommitVertical, Minus, Plus, RefreshCw, SquareStack } from 'lucide-react'
import type { GitFile, GitStatus } from '@shared/types'
import type { SshHost } from '@shared/ssh'
import { useStore } from '../store/useStore'

export function DiffView({ text }: { text: string }): React.JSX.Element {
  const lines = text.split('\n')
  return (
    <div className="diff">
      {lines.map((line, i) => {
        let kind = ' '
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) kind = 'h'
        else if (line.startsWith('@@')) kind = '@'
        else if (line.startsWith('+')) kind = '+'
        else if (line.startsWith('-')) kind = '-'
        return (
          <div className="diff-line" data-t={kind} key={i}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

export function GitPanel({
  cwd,
  host,
  workspaceId
}: {
  cwd: string
  /** Set for a remote workspace — every call below runs over ssh instead. */
  host?: SshHost | null
  /**
   * Present only when this is the dock's own copy — lets it split out into
   * its own grid pane. Left undefined when GitPanel is rendered *as* a diff
   * pane's body (DiffGridPane), so a pane cannot offer to pop out a second
   * copy of itself.
   */
  workspaceId?: string
}): React.JSX.Element {
  const notify = useStore((s) => s.notify)
  const addPane = useStore((s) => s.addPane)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [selected, setSelected] = useState<GitFile | null>(null)
  const [diff, setDiff] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const next = await window.eaon.git.status(cwd, host)
    setStatus(next)
    return next
  }, [cwd, host])

  useEffect(() => {
    setSelected(null)
    setDiff('')
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!selected) return
    window.eaon.git.diff(cwd, selected.path, selected.staged, host).then(setDiff)
  }, [selected, cwd, host])

  if (status && !status.repo) {
    return (
      <div className="panel">
        <div className="empty" style={{ height: '100%' }}>
          <strong>This folder is not a git repository.</strong>
          <span>Run git init in a pane to start tracking it.</span>
        </div>
      </div>
    )
  }

  const staged = status?.files.filter((f) => f.staged) ?? []
  const changed = status?.files.filter((f) => !f.staged) ?? []

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      const next = await refresh()
      if (selected && !next.files.some((f) => f.path === selected.path)) setSelected(null)
    } finally {
      setBusy(false)
    }
  }

  const row = (f: GitFile): React.JSX.Element => (
    <button
      className="git-file"
      key={`${f.staged ? 's' : 'w'}-${f.path}`}
      data-on={selected?.path === f.path && selected.staged === f.staged}
      onClick={() => setSelected(f)}
      title={f.path}
    >
      <span className="git-code" data-kind={(f.staged ? f.index : f.work).trim() || '?'}>
        {(f.staged ? f.index : f.work).trim() || '?'}
      </span>
      <span className="git-path">{f.path}</span>
      <span
        className="icon-btn"
        role="button"
        tabIndex={0}
        style={{ width: 18, height: 18 }}
        aria-label={f.staged ? 'Unstage' : 'Stage'}
        onClick={(e) => {
          e.stopPropagation()
          void act(() =>
            f.staged ? window.eaon.git.unstage(cwd, f.path, host) : window.eaon.git.stage(cwd, f.path, host)
          )
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.stopPropagation()
          void act(() =>
            f.staged ? window.eaon.git.unstage(cwd, f.path, host) : window.eaon.git.stage(cwd, f.path, host)
          )
        }}
      >
        {f.staged ? <Minus size={11} /> : <Plus size={11} />}
      </span>
    </button>
  )

  return (
    <div className="panel">
      <div className="panel-bar">
        <GitBranch size={13} color="var(--accent)" />
        <span style={{ flex: 1, fontSize: 12, color: 'var(--text-mid)' }} className="mono">
          {status?.branch ?? '…'}
        </span>
        {status && status.ahead > 0 && <span className="chip">↑{status.ahead}</span>}
        {status && status.behind > 0 && <span className="chip">↓{status.behind}</span>}
        {workspaceId && (
          <button
            className="icon-btn"
            onClick={() => addPane(workspaceId, { kind: 'diff' })}
            title="Open in its own pane, beside your terminals"
            aria-label="Open in its own pane"
          >
            <SquareStack size={13} />
          </button>
        )}
        <button className="icon-btn" onClick={() => void refresh()} aria-label="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="panel-split">
        <div className="panel-side">
          {staged.length > 0 && (
            <>
              <p className="eyebrow" style={{ padding: '8px 8px 4px' }}>
                Staged {staged.length}
              </p>
              {staged.map(row)}
            </>
          )}
          {changed.length > 0 && (
            <>
              <p className="eyebrow" style={{ padding: '10px 8px 4px' }}>
                Changed {changed.length}
              </p>
              {changed.map(row)}
            </>
          )}
          {status && status.files.length === 0 && (
            <p style={{ padding: 10, fontSize: 12, color: 'var(--text-dim)' }}>
              Working tree is clean.
            </p>
          )}
        </div>

        <div className="panel-main">
          {selected ? (
            <DiffView text={diff} />
          ) : (
            <div className="empty">
              <strong>Pick a file to see what changed.</strong>
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--line-100)', padding: 10, display: 'grid', gap: 8 }}>
            <textarea
              className="prompt-box"
              style={{ minHeight: 56 }}
              value={message}
              placeholder="Commit message"
              onChange={(e) => setMessage(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn"
                style={{ height: 30 }}
                disabled={busy || !changed.length}
                onClick={() => void act(() => window.eaon.git.stageAll(cwd, host))}
              >
                <Plus size={13} />
                Stage everything
              </button>
              <span style={{ flex: 1 }} />
              <button
                className="btn btn-primary"
                style={{ height: 30 }}
                disabled={busy || !message.trim() || !staged.length}
                onClick={() =>
                  void act(async () => {
                    const out = await window.eaon.git.commit(cwd, message.trim(), host)
                    setMessage('')
                    notify({ kind: 'info', title: 'Commit', text: out.split('\n')[0] })
                  })
                }
              >
                {busy ? <Check size={13} /> : <GitCommitVertical size={13} />}
                Commit {staged.length || ''}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
