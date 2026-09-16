import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, ChevronLeft, FileDiff, FileMinus2, FilePlus2, Loader, RefreshCw } from 'lucide-react'
import type { PrDetail, PrFile, WorkItem } from '@shared/tasks'
import { useStore } from '../store/useStore'
import { DiffView } from './GitPanel'

type ReviewTab = 'files' | 'changes' | 'review'
type ReviewEvent = 'approve' | 'comment' | 'request-changes'

/** Everything up to the last slash — the group a file's row sits under. */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function FileIcon({ changeType }: { changeType: PrFile['changeType'] }): React.JSX.Element {
  if (changeType === 'ADDED') return <FilePlus2 size={13} />
  if (changeType === 'DELETED') return <FileMinus2 size={13} />
  return <FileDiff size={13} />
}

/**
 * One pull request's changeset — diffstat, the files it touches grouped by
 * directory, each file's own diff, and the three ways to answer it.
 *
 * `gh pr view`'s `files` array already carries per-file add/delete counts and
 * a change kind, so the Files tab needs no diff parsing at all; only the
 * Changes tab reads into the unified diff `prDiff` already split per path.
 */
export function PrReviewPanel({
  item,
  cwd,
  onClose,
  onReviewed
}: {
  item: WorkItem
  cwd: string
  onClose: () => void
  /** A review action just changed this PR's state — let the list catch up. */
  onReviewed: () => void
}): React.JSX.Element {
  const notify = useStore((s) => s.notify)
  // Every provider's ref carries the leading mark ("#", "!"); reviewing is
  // GitHub-only today (see the row's own guard in TasksPanel), so this
  // panel is never opened for anything but a plain numeric PR ref.
  const number = Number(item.ref.replace(/^#/, ''))

  const [detail, setDetail] = useState<PrDetail | { error: string } | null>(null)
  const [diffs, setDiffs] = useState<Record<string, string> | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<ReviewTab>('files')
  const [reviewBody, setReviewBody] = useState('')
  const [busy, setBusy] = useState<ReviewEvent | null>(null)

  const load = (): void => {
    setDetail(null)
    setDiffs(null)
    setSelected(null)
    void window.eaon.tasks.prDetail(cwd, number).then(setDetail)
    void window.eaon.tasks.prDiff(cwd, number).then(setDiffs)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [cwd, number])

  const groups = useMemo((): [string, PrFile[]][] => {
    if (!detail || 'error' in detail) return []
    const byDir = new Map<string, PrFile[]>()
    for (const f of detail.files) {
      const dir = dirOf(f.path)
      const list = byDir.get(dir) ?? []
      list.push(f)
      byDir.set(dir, list)
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [detail])

  const pick = (path: string): void => {
    setSelected(path)
    setTab('changes')
  }

  const review = async (event: ReviewEvent): Promise<void> => {
    setBusy(event)
    try {
      const res = await window.eaon.tasks.reviewPr(cwd, number, event, reviewBody)
      notify({
        kind: res.ok ? 'info' : 'error',
        title: res.ok ? `${item.ref} reviewed` : `Could not review ${item.ref}`,
        text: res.message
      })
      if (res.ok) {
        setReviewBody('')
        onReviewed()
      }
    } finally {
      setBusy(null)
    }
  }

  const failed = detail && 'error' in detail ? detail.error : null

  return (
    <div className="panel pr-panel">
      <div className="panel-bar">
        <button className="icon-btn" onClick={onClose} aria-label="Back to the list" title="Back to the list">
          <ChevronLeft size={15} />
        </button>
        <span className="wk-title" style={{ flex: 1 }} title={item.title}>
          {item.ref} {item.title}
        </span>
        <button className="icon-btn" onClick={load} aria-label="Refresh" title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {failed ? (
        <div className="empty" style={{ height: '100%' }}>
          <strong>Could not load this pull request.</strong>
          <span>{failed}</span>
        </div>
      ) : (
        <>
          <div className="pr-stat">
            {detail && !('error' in detail) ? (
              <>
                <span className="pr-add">+{detail.additions}</span>
                <span className="pr-del">−{detail.deletions}</span>
                <span className="pr-dim">
                  · {detail.changedFiles} file{detail.changedFiles === 1 ? '' : 's'}
                </span>
                <span style={{ flex: 1 }} />
                <span className="chip" title={`Merges into ${detail.baseRefName}`}>
                  <ArrowRight size={11} />
                  {detail.baseRefName}
                </span>
              </>
            ) : (
              <span className="pr-dim">Loading…</span>
            )}
          </div>

          <div className="pr-tabs">
            {(['files', 'changes', 'review'] as const).map((t) => (
              <button key={t} className="pr-tab" data-on={tab === t} onClick={() => setTab(t)}>
                {t === 'files' ? 'Files' : t === 'changes' ? 'Changes' : 'Review'}
              </button>
            ))}
          </div>

          <div className="pr-body">
            {tab === 'files' &&
              (detail ? (
                <div className="pr-files">
                  {groups.map(([dir, files]) => (
                    <div key={dir || '/'}>
                      <p className="eyebrow" style={{ padding: '8px 10px 4px' }}>
                        {dir ? dir.toUpperCase() : 'ROOT'}
                      </p>
                      {files.map((f) => (
                        <button
                          key={f.path}
                          className="pr-file"
                          data-on={selected === f.path}
                          onClick={() => pick(f.path)}
                          title={f.path}
                        >
                          <span className="pr-file-icon" data-kind={f.changeType}>
                            <FileIcon changeType={f.changeType} />
                          </span>
                          <span className="pr-file-name">
                            {dir ? f.path.slice(dir.length + 1) : f.path}
                          </span>
                          <span className="pr-file-stat">
                            {f.additions > 0 && <span className="pr-add">+{f.additions}</span>}
                            {f.deletions > 0 && <span className="pr-del">−{f.deletions}</span>}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="wk-note">Loading files…</p>
              ))}

            {tab === 'changes' &&
              (selected ? (
                diffs ? (
                  <DiffView text={diffs[selected] ?? ''} />
                ) : (
                  <p className="wk-note">Loading diff…</p>
                )
              ) : (
                <div className="empty" style={{ height: '100%' }}>
                  <strong>Pick a file in Files to see what changed.</strong>
                </div>
              ))}

            {tab === 'review' && (
              <div className="pr-review-form">
                <textarea
                  className="prompt-box"
                  style={{ minHeight: 96 }}
                  value={reviewBody}
                  placeholder="Leave a comment (required for Comment, optional for the others)"
                  onChange={(e) => setReviewBody(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="wk-btn"
                    disabled={!!busy}
                    onClick={() => void review('request-changes')}
                  >
                    {busy === 'request-changes' && <Loader size={11} className="spin" />}
                    Request changes
                  </button>
                  <button
                    className="wk-btn"
                    disabled={!!busy || !reviewBody.trim()}
                    onClick={() => void review('comment')}
                  >
                    {busy === 'comment' && <Loader size={11} className="spin" />}
                    Comment
                  </button>
                  <span style={{ flex: 1 }} />
                  <button
                    className="wk-btn wk-btn-primary"
                    disabled={!!busy}
                    onClick={() => void review('approve')}
                  >
                    {busy === 'approve' && <Loader size={11} className="spin" />}
                    Approve
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
