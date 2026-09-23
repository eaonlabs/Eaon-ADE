import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  CircleDot,
  GitPullRequest,
  Loader,
  Plus,
  RefreshCw,
  TriangleAlert
} from 'lucide-react'
import type { LinearTeam, TaskFetch, TaskProvider, WorkItem } from '@shared/tasks'
import { useStore } from '../store/useStore'
import { PrReviewPanel } from './PrReviewPanel'

/**
 * Work waiting for you, in the side dock.
 *
 * Pull requests, issues and Linear tickets in one list, because "what should
 * I pick up" is one question and answering it across three tabs is three
 * questions. The action that matters on every row is the same one — open an
 * isolated checkout and start working — so it is the button on every row.
 */

const FILTERS: { id: 'all' | TaskProvider; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'github', label: 'GitHub' },
  { id: 'gitlab', label: 'GitLab' },
  { id: 'linear', label: 'Linear' }
]

function Row({
  item,
  busy,
  onOpen,
  onApprove,
  onReview
}: {
  item: WorkItem
  busy: boolean
  onOpen: () => void
  onApprove: () => void
  onReview: () => void
}): React.JSX.Element {
  const openUrl = (): void => window.eaon.sys.openExternal(item.url)
  return (
    <div className="wk-row" data-tone={item.tone}>
      <span className="wk-icon" aria-hidden="true">
        {item.kind === 'pr' ? <GitPullRequest size={13} /> : <CircleDot size={13} />}
      </span>

      <span className="wk-body">
        <span className="wk-title-line">
          <button className="wk-ref mono" onClick={openUrl} title={`Open ${item.url}`}>
            {item.ref}
          </button>
          <span className="wk-title" title={item.title}>
            {item.title}
          </span>
        </span>
        <span className="wk-meta">
          <span className="wk-state" data-tone={item.tone}>
            {item.state}
          </span>
          {item.author && <span className="wk-author">{item.author}</span>}
          {item.reviewDecision === 'APPROVED' && (
            <span className="wk-review" data-kind="approved">
              <Check size={10} />
              approved
            </span>
          )}
          {item.reviewDecision === 'CHANGES_REQUESTED' && (
            <span className="wk-review" data-kind="changes">
              <TriangleAlert size={10} />
              changes requested
            </span>
          )}
          {item.labels.slice(0, 2).map((l) => (
            <span className="wk-label" key={l}>
              {l}
            </span>
          ))}
        </span>
      </span>

      <span className="wk-actions">
        {item.kind === 'pr' && item.provider === 'github' && (
          <button
            className="wk-btn"
            onClick={onReview}
            disabled={busy}
            title="See what changed, file by file"
          >
            Review
          </button>
        )}
        {item.kind === 'pr' && item.provider === 'github' && item.tone !== 'merged' && (
          <button className="wk-btn" onClick={onApprove} disabled={busy} title="Approve this pull request">
            Approve
          </button>
        )}
        <button
          className="wk-btn wk-btn-primary"
          onClick={onOpen}
          disabled={busy}
          title={
            item.branchExists
              ? `Check out ${item.branch} in its own worktree`
              : `Cut ${item.branch} in its own worktree`
          }
        >
          {busy ? <Loader size={11} className="spin" /> : null}
          Open
        </button>
      </span>
    </div>
  )
}

function NewLinearIssue({ onDone }: { onDone: (msg: string, url?: string) => void }): React.JSX.Element {
  const [teams, setTeams] = useState<LinearTeam[] | null>(null)
  const [teamId, setTeamId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    window.eaon.tasks.linearTeams().then((list) => {
      if (!live) return
      setTeams(list)
      if (list.length) setTeamId((current) => current || list[0].id)
    })
    return () => {
      live = false
    }
  }, [])

  if (teams === null) return <p className="wk-note">Loading teams…</p>
  if (teams.length === 0) {
    return <p className="wk-note">No Linear teams — set LINEAR_API_KEY in Settings → Integrations.</p>
  }

  const submit = async (): Promise<void> => {
    if (!title.trim() || !teamId) return
    setBusy(true)
    try {
      const res = await window.eaon.tasks.createLinearIssue({
        teamId,
        title: title.trim(),
        description: description.trim() || undefined
      })
      onDone(res.message, res.url)
      if (res.ok) {
        setTitle('')
        setDescription('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wk-new">
      <select
        className="wk-select"
        value={teamId}
        onChange={(e) => setTeamId(e.target.value)}
        aria-label="Linear team"
      >
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.key} · {t.name}
          </option>
        ))}
      </select>
      <input
        className="wk-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Issue title"
      />
      <textarea
        className="wk-input wk-textarea"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
      />
      <button className="wk-btn wk-btn-primary" disabled={busy || !title.trim()} onClick={() => void submit()}>
        {busy ? <Loader size={11} className="spin" /> : <Plus size={11} />}
        Create in Linear
      </button>
    </div>
  )
}

export function TasksPanel({ cwd }: { cwd: string }): React.JSX.Element {
  const notify = useStore((s) => s.notify)
  const openWorkItem = useStore((s) => s.openWorkItem)

  const [fetched, setFetched] = useState<TaskFetch | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | TaskProvider>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [reviewing, setReviewing] = useState<WorkItem | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setFetched(await window.eaon.tasks.list(cwd))
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setReviewing(null)
  }, [cwd])

  const items = (fetched?.items ?? []).filter((i) => filter === 'all' || i.provider === filter)

  const open = async (item: WorkItem): Promise<void> => {
    setBusyId(item.id)
    try {
      const res = await openWorkItem(item)
      notify(
        res.ok
          ? { kind: 'info', title: `Opened ${item.ref}`, text: `Working in ${item.branch}.` }
          : { kind: 'error', title: `Could not open ${item.ref}`, text: res.error ?? '' }
      )
    } finally {
      setBusyId(null)
    }
  }

  const approve = async (item: WorkItem): Promise<void> => {
    const number = Number(item.ref.replace(/^#/, ''))
    if (!Number.isFinite(number)) return
    setBusyId(item.id)
    try {
      const res = await window.eaon.tasks.approvePr(cwd, number)
      notify({
        kind: res.ok ? 'info' : 'error',
        title: res.ok ? `Approved ${item.ref}` : `Could not approve ${item.ref}`,
        text: res.message
      })
      if (res.ok) void load()
    } finally {
      setBusyId(null)
    }
  }

  if (reviewing) {
    return (
      <PrReviewPanel
        item={reviewing}
        cwd={cwd}
        onClose={() => setReviewing(null)}
        onReviewed={() => void load()}
      />
    )
  }

  return (
    <div className="panel wk-panel">
      <div className="panel-bar">
        <span className="wk-filters">
          {FILTERS.map((f) => (
            <button key={f.id} className="wk-filter" data-on={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          onClick={() => setComposing((v) => !v)}
          aria-label="New Linear issue"
          title="New Linear issue"
        >
          <Plus size={13} />
        </button>
        <button className="icon-btn" onClick={() => void load()} aria-label="Refresh" title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="wk-scroll">
        {composing && <NewLinearIssue onDone={(message, url) => {
          notify({ kind: 'info', title: 'Linear', text: message })
          if (url) setComposing(false)
          void load()
        }} />}

        {loading && !fetched ? (
          <p className="wk-note">Looking for work…</p>
        ) : items.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}>
            <strong>Nothing open here.</strong>
            <span>Pull requests, issues and Linear tickets show up in this list.</span>
          </div>
        ) : (
          items.map((item) => (
            <Row
              key={item.id}
              item={item}
              busy={busyId === item.id}
              onOpen={() => void open(item)}
              onApprove={() => void approve(item)}
              onReview={() => setReviewing(item)}
            />
          ))
        )}

        {/*
          A provider that could not answer is said out loud rather than
          showing as an empty list — "no PRs" and "gh is not installed" look
          identical otherwise, and only one of them is actionable.
        */}
        {fetched?.notes.map((n, i) => (
          <p className="wk-note wk-note-warn" key={`${n.provider}-${i}`}>
            <TriangleAlert size={11} />
            <span>
              <strong>{n.provider}</strong> — {n.message}
            </span>
          </p>
        ))}
      </div>
    </div>
  )
}
