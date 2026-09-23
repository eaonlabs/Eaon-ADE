import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronRight,
  ExternalLink,
  FileDiff,
  FileMinus2,
  FilePlus2,
  GitPullRequest,
  Loader,
  MessageSquare,
  RefreshCw,
  Search,
  TriangleAlert
} from 'lucide-react'
import type { PrDetail, PrFile, TaskFetch, WorkItem } from '@shared/tasks'
import { FilePreviewBody } from './FilePreviewBody'
import { DiffView } from './GitPanel'
import { PrReviewPanel } from './PrReviewPanel'

/**
 * Every pull request in one folder, with a preview beside the list.
 *
 * The dock's Work tab answers "what should I pick up" across three providers
 * in a 210px column. This answers a different question — "what is in flight,
 * and what is in it" — which wants room: the list stays on the left while a
 * pull request opens on the right, so comparing two of them is two clicks
 * rather than two round trips through a back button.
 *
 * It has its own fetch, `tasks.pullRequests(cwd, state)`, rather than sieving
 * the dock's list. Not duplication — a different question. The dock asks "what
 * should I pick up", so open-only is right there and a merged pull request is
 * noise you cannot act on; this page asks "show me this repo's pull requests",
 * and its Merged tab could not fill at all while the only fetch in the module
 * was open-only. The rows are still normalised `WorkItem`s, so no provider
 * vocabulary reaches this file — see `shared/tasks.ts`.
 */

/**
 * Open, merged, or everything.
 *
 * These are the three states `tasks.pullRequests` accepts, not three ways of
 * sieving one list — picking a tab refetches. That is the whole reason the
 * Merged tab works at all: the fetch behind this page used to be open-only,
 * so merged rows were never sent, and no amount of filtering in here could
 * conjure them. Tone rather than provider, which is what the dock filters by:
 * in a list that is only pull requests, "whose host is it" matters far less
 * than "is this still live".
 */
type PrFilter = 'all' | 'open' | 'merged'

const FILTERS: { id: PrFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'merged', label: 'Merged' }
]

/** Everything on a row a person might plausibly type to find it again. */
function haystack(item: WorkItem): string {
  return [item.ref, item.title, item.author ?? '', item.branch ?? '', ...item.labels]
    .join(' ')
    .toLowerCase()
}

/**
 * Why the list is empty, which is not one situation but several.
 *
 * Each tab is its own question asked of the host, so an empty one is a real
 * answer about that state rather than a filter that matched nothing — and it
 * should read that way. This used to carry an apology for the Merged tab,
 * which could never fill while the fetch behind it was open-only; that is
 * fixed in `tasks.pullRequests`, so the apology is gone.
 */
function emptyReason(filter: PrFilter, query: string): { title: string; detail: string } {
  if (query.trim()) {
    return {
      title: 'Nothing matches.',
      detail: 'Clear the search, or look in another tab.'
    }
  }
  if (filter === 'merged') {
    return {
      title: 'Nothing merged yet.',
      detail: 'Merged pull requests collect here once this folder has one.'
    }
  }
  if (filter === 'open') {
    return {
      title: 'No open pull requests.',
      detail: 'They show up here as soon as somebody opens one.'
    }
  }
  return {
    title: 'No pull requests here.',
    detail: 'Nothing open, merged or closed on this folder’s remote.'
  }
}

/**
 * The list after the search box — the only narrowing this side still does.
 *
 * The tabs are gone from here on purpose. `tasks.pullRequests` is asked for
 * one state and answers with exactly that, so re-checking the tone in the
 * renderer would be the client second-guessing the fetch: harmless while the
 * two agree, and a row that silently vanishes the day they stop. One place
 * decides what state means, and it is not this one.
 *
 * Expects a list of pull requests; `pullRequests()` builds one by
 * construction, so there is no kind to sieve out any more either.
 */
export function visiblePullRequests(items: WorkItem[], query: string): WorkItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((i) => haystack(i).includes(q))
}

function Row({
  item,
  selected,
  onSelect
}: {
  item: WorkItem
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <div className="wk-row pr-row" data-tone={item.tone} data-on={selected}>
      {/*
        The picker and the link-out are siblings, not one inside the other.
        A row that is itself a button cannot hold another button, and the
        alternative — a div wearing role="button" — loses the keyboard and
        focus behaviour a button has for free.
      */}
      <button
        className="pr-pick"
        onClick={onSelect}
        aria-pressed={selected}
        title={`Preview ${item.ref}`}
      >
        <span className="wk-icon" aria-hidden="true">
          <GitPullRequest size={13} />
        </span>
        <span className="wk-body">
          <span className="wk-title-line">
            <span className="wk-ref mono">{item.ref}</span>
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
      </button>

      <span className="wk-actions">
        <button
          className="icon-btn"
          onClick={() => window.eaon.sys.openExternal(item.url)}
          aria-label={`Open ${item.ref} in your browser`}
          title={item.url}
        >
          <ExternalLink size={12} />
        </button>
      </span>
    </div>
  )
}

function FileGlyph({ changeType }: { changeType: PrFile['changeType'] }): React.JSX.Element {
  if (changeType === 'ADDED') return <FilePlus2 size={13} />
  if (changeType === 'DELETED') return <FileMinus2 size={13} />
  return <FileDiff size={13} />
}

/**
 * One pull request, read rather than answered.
 *
 * The description and the changed files, which is what you want before
 * deciding whether to pick something up. Answering it — approve, comment,
 * request changes — is a different intent and stays where it already lived,
 * one button away in `PrReviewPanel`, rather than being built twice.
 */
function PrPreview({
  item,
  cwd,
  onReview
}: {
  item: WorkItem
  cwd: string
  onReview: () => void
}): React.JSX.Element {
  // Every provider's ref carries its own mark; the caller only renders this
  // for GitHub, whose refs are "#" and a number.
  const number = Number(item.ref.replace(/^#/, ''))

  const [detail, setDetail] = useState<PrDetail | { error: string } | null>(null)
  const [diffs, setDiffs] = useState<Record<string, string> | null>(null)
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)

  useEffect(() => {
    let live = true
    setDetail(null)
    setDiffs(null)
    setOpenFile(null)
    void window.eaon.tasks.prDetail(cwd, number).then((d) => {
      if (live) setDetail(d)
    })
    return () => {
      live = false
    }
  }, [cwd, number])

  /*
   * The patches are fetched on the first file anybody opens, not with the
   * detail.
   *
   * `prDiff` answers with every file's patch in one call, so this is one
   * request either way — but it is a request proportional to the size of the
   * changeset, and selecting a pull request to read its description should
   * not pull a ten-thousand-line diff nobody asked to see.
   */
  const toggle = async (path: string): Promise<void> => {
    if (openFile === path) {
      setOpenFile(null)
      return
    }
    setOpenFile(path)
    if (diffs || loadingDiff) return
    setLoadingDiff(true)
    try {
      setDiffs(await window.eaon.tasks.prDiff(cwd, number))
    } finally {
      setLoadingDiff(false)
    }
  }

  const failed = detail && 'error' in detail ? detail.error : null
  const stat = detail && !('error' in detail) ? detail : null
  const body = item.body?.trim()

  return (
    <div className="pr-preview">
      <header className="pr-head">
        <div className="pr-head-top">
          <h2 className="pr-head-title" title={item.title}>
            {item.title}
          </h2>
          <button className="wk-btn" onClick={onReview} title="Approve, comment or request changes">
            <MessageSquare size={11} />
            Review
          </button>
          <button
            className="icon-btn"
            onClick={() => window.eaon.sys.openExternal(item.url)}
            aria-label={`Open ${item.ref} in your browser`}
            title={item.url}
          >
            <ExternalLink size={13} />
          </button>
        </div>

        <div className="pr-head-meta">
          <span className="wk-ref mono">{item.ref}</span>
          <span className="wk-state" data-tone={item.tone}>
            {item.state}
          </span>
          {item.author && <span className="pr-head-author">{item.author}</span>}
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
          {item.branch && stat && (
            <span className="pr-head-branches mono" title={`${item.branch} into ${stat.baseRefName}`}>
              {item.branch}
              <ArrowRight size={10} />
              {stat.baseRefName}
            </span>
          )}
        </div>
      </header>

      <div className="pr-preview-scroll">
        {body ? (
          /*
            The same renderer the Pages surface uses, given the text directly
            rather than a path — `marked` behind DOMPurify, and link clicks
            already routed to a real browser. A pull request description is
            exactly as untrusted as a README, and gets the same treatment.
          */
          <div className="pr-body-md">
            <FilePreviewBody path="pull-request.md" markdownOverride={body} />
          </div>
        ) : (
          <p className="wk-note">No description.</p>
        )}

        {failed ? (
          <p className="wk-note wk-note-warn">
            <TriangleAlert size={11} />
            <span>{failed}</span>
          </p>
        ) : (
          <>
            <div className="pr-stat">
              {stat ? (
                <>
                  <span className="pr-add">+{stat.additions}</span>
                  <span className="pr-del">−{stat.deletions}</span>
                  <span className="pr-dim">
                    · {stat.changedFiles} file{stat.changedFiles === 1 ? '' : 's'}
                  </span>
                  <span className="pr-dim">·</span>
                  <span className="chip" title={`Merges into ${stat.baseRefName}`}>
                    <ArrowRight size={11} />
                    {stat.baseRefName}
                  </span>
                </>
              ) : (
                <span className="pr-dim">Loading…</span>
              )}
            </div>

            {stat && (
              <div className="pr-files">
                {stat.files.map((f) => {
                  const open = openFile === f.path
                  const cut = f.path.lastIndexOf('/')
                  return (
                    <div key={f.path}>
                      <button
                        className="pr-file"
                        data-on={open}
                        onClick={() => void toggle(f.path)}
                        aria-expanded={open}
                        title={f.path}
                      >
                        <span className="pr-file-caret" data-open={open} aria-hidden="true">
                          <ChevronRight size={12} />
                        </span>
                        <span className="pr-file-icon" data-kind={f.changeType}>
                          <FileGlyph changeType={f.changeType} />
                        </span>
                        <span className="pr-file-name">
                          {cut !== -1 && <span className="pr-file-dir">{f.path.slice(0, cut + 1)}</span>}
                          {f.path.slice(cut + 1)}
                        </span>
                        <span className="pr-file-stat">
                          {f.additions > 0 && <span className="pr-add">+{f.additions}</span>}
                          {f.deletions > 0 && <span className="pr-del">−{f.deletions}</span>}
                        </span>
                      </button>
                      {open && (
                        <div className="pr-file-diff">
                          {diffs ? (
                            <DiffView text={diffs[f.path] ?? ''} />
                          ) : (
                            <p className="wk-note">
                              <Loader size={11} className="spin" />
                              <span>Reading the diff…</span>
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function PullRequestsPage({ cwd }: { cwd: string }): React.JSX.Element {
  const [fetched, setFetched] = useState<TaskFetch | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<PrFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** Reading it, or answering it. Selecting anything starts you reading. */
  const [mode, setMode] = useState<'preview' | 'review'>('preview')

  /*
   * One request per tab, and the answers are not guaranteed to come back in
   * the order they were asked for. Clicking All and then Merged fires two
   * `gh` calls; without this the slower first one lands last and leaves the
   * Merged tab showing everything. The token says which request is still the
   * one being waited for.
   */
  const request = useRef(0)
  const load = useCallback(async (): Promise<void> => {
    const mine = (request.current += 1)
    setLoading(true)
    try {
      const next = await window.eaon.tasks.pullRequests(cwd, filter)
      if (request.current !== mine) return
      setFetched(next)
    } finally {
      if (request.current === mine) setLoading(false)
    }
  }, [cwd, filter])

  useEffect(() => {
    void load()
  }, [load])

  // A different folder is a different set of pull requests; keeping the
  // selection would leave the preview showing one that is no longer listed.
  useEffect(() => {
    setSelectedId(null)
  }, [cwd])

  // What the host sent for the tab being shown, before the search box.
  const prs = fetched?.items ?? []
  const shown = useMemo(() => visiblePullRequests(prs, query), [prs, query])

  // Read back out of the list rather than held as an object, so a refresh
  // that changes a pull request's state previews the new one, not the stale
  // copy captured when it was clicked.
  const selected = prs.find((i) => i.id === selectedId) ?? null

  const empty = emptyReason(filter, query)
  const notes = fetched?.notes ?? []
  /*
   * A provider that could not answer is only worth shouting about when it
   * left nothing behind. With pull requests on screen the note is a footnote
   * — one host being unreachable while another answered. With none, it is the
   * whole story, and almost always fixable: no GitHub remote, gh not on PATH,
   * a folder that has been deleted.
   */
  const failed = prs.length === 0 && notes.length > 0

  return (
    <div className="panel pr-page">
      <div className="panel-split pr-page-split">
        <div className="pr-page-side">
          <div className="pr-page-head">
            <span className="wk-filters">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  className="wk-filter"
                  data-on={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </span>
            <div className="field pr-search">
              <Search size={13} color="var(--text-dim)" />
              <input
                value={query}
                spellCheck={false}
                placeholder="Search pull requests..."
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search pull requests"
              />
            </div>
          </div>

          <div className="pr-page-count">
            <span className="eyebrow">
              {loading && !fetched
                ? 'Loading'
                : `${shown.length} pull request${shown.length === 1 ? '' : 's'}`}
            </span>
            {/* Rows from the previous tab stay up while the next arrives, so
                without this the count looks settled when it is not. */}
            {loading && fetched && <Loader size={11} className="spin" />}
            <span style={{ flex: 1 }} />
            <button
              className="icon-btn"
              onClick={() => void load()}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw size={13} />
            </button>
          </div>

          <div className="wk-scroll">
            {failed ? (
              <div className="pr-fail" role="alert">
                {notes.map((n, i) => (
                  <p className="pr-fail-line" key={`${n.provider}-${i}`}>
                    <TriangleAlert size={12} />
                    <span>
                      <strong>{n.provider}</strong> — {n.message}
                    </span>
                  </p>
                ))}
                <button className="wk-btn" onClick={() => void load()}>
                  Try again
                </button>
              </div>
            ) : shown.length === 0 ? (
              <div className="empty" style={{ padding: 20 }}>
                <strong>{empty.title}</strong>
                <span>{empty.detail}</span>
              </div>
            ) : (
              shown.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  onSelect={() => {
                    setSelectedId(item.id)
                    setMode('preview')
                  }}
                />
              ))
            )}

            {/* Still said, quietly, when there was other work to show. */}
            {!failed &&
              notes.map((n, i) => (
                <p className="wk-note wk-note-warn" key={`${n.provider}-${i}`}>
                  <TriangleAlert size={11} />
                  <span>
                    <strong>{n.provider}</strong> — {n.message}
                  </span>
                </p>
              ))}
          </div>
        </div>

        <div className="panel-main pr-page-preview">
          {selected ? (
            selected.provider === 'github' ? (
              mode === 'review' ? (
                /*
                  Reused whole rather than reimplemented — it already carries
                  the three ways to answer a review, and rebuilding those here
                  would be the same UI twice. Its Back button returns to the
                  description, which is where Review was pressed from.
                */
                <PrReviewPanel
                  key={selected.id}
                  item={selected}
                  cwd={cwd}
                  onClose={() => setMode('preview')}
                  onReviewed={() => void load()}
                />
              ) : (
                <PrPreview
                  key={selected.id}
                  item={selected}
                  cwd={cwd}
                  onReview={() => setMode('review')}
                />
              )
            ) : (
              <div className="empty pr-page-empty">
                <GitPullRequest size={26} />
                <strong>{selected.ref} lives on {selected.provider}.</strong>
                <span>
                  Previewing a changeset in here needs the GitHub CLI. Open it in your browser
                  instead.
                </span>
                <button
                  className="wk-btn"
                  onClick={() => window.eaon.sys.openExternal(selected.url)}
                >
                  <ExternalLink size={12} />
                  Open {selected.ref}
                </button>
              </div>
            )
          ) : (
            <div className="empty pr-page-empty">
              <GitPullRequest size={26} />
              <strong>Select a pull request to preview it here.</strong>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
