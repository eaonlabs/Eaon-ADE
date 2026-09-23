import { useEffect, useMemo, useState } from 'react'
import { Flame, FolderOpen, Globe, GitCommitHorizontal, MessagesSquare, Minus, Plus } from 'lucide-react'
import { UsageOverview } from './UsageOverview'
import type { Stats as StatsData, StatsDay } from '@shared/stats'
import { EMPTY_STATS } from '@shared/stats'
import { useActiveWorkspace, useStore } from '../store/useStore'
import { shortPath } from '../lib/util'

type Metric = 'activity' | 'sessions' | 'commits' | 'lines'

const METRICS: { id: Metric; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'commits', label: 'Commits' },
  { id: 'lines', label: 'Lines' }
]

function valueOf(day: StatsDay, metric: Metric): number {
  switch (metric) {
    case 'sessions':
      return day.sessions
    case 'commits':
      return day.commits
    case 'lines':
      return day.added + day.removed
    default:
      return day.sessions + day.commits
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Midday, so a date-only string is never dragged into the previous day. */
function asDate(key: string): Date {
  return new Date(`${key}T12:00:00`)
}

function longDate(key: string): string {
  const d = asDate(key)
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

function compact(n: number): string {
  if (Math.abs(n) < 1000) return String(n)
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

/**
 * The year at a glance.
 *
 * Two sources sit side by side rather than being added together: the agent
 * transcripts say when you were working, git says what came out of it. A day
 * spent reading and deciding produces no diff, and a chart that only counted
 * commits would call that day empty.
 */
export function Stats(): React.JSX.Element {
  const workspace = useActiveWorkspace()
  const home = useStore((s) => s.home)
  const folder = workspace?.cwd ?? null

  const [everywhere, setEverywhere] = useState(false)
  const [data, setData] = useState<StatsData | null>(null)
  const [metric, setMetric] = useState<Metric>('activity')
  const [hover, setHover] = useState<StatsDay | null>(null)

  const scope = folder && !everywhere ? folder : null

  useEffect(() => {
    let live = true
    setData(null)
    window.eaon.stats.get(scope).then((s) => {
      if (live) setData(s)
    })
    return () => {
      live = false
    }
  }, [scope])

  const stats = data ?? EMPTY_STATS

  // Columns of seven. The final one is short whenever the week is still running.
  const weeks = useMemo(() => {
    const out: StatsDay[][] = []
    for (let i = 0; i < stats.days.length; i += 7) out.push(stats.days.slice(i, i + 7))
    return out
  }, [stats.days])

  const max = useMemo(
    () => stats.days.reduce((m, d) => Math.max(m, valueOf(d, metric)), 0),
    [stats.days, metric]
  )

  const level = (day: StatsDay): number => {
    const v = valueOf(day, metric)
    if (v <= 0) return 0
    if (max <= 0) return 0
    // Four filled steps, scaled to the busiest day so a quiet project still
    // shows contrast rather than one faint shade throughout.
    return Math.min(4, Math.ceil((v / max) * 4))
  }

  const monthLabels = useMemo(() => {
    const out: { col: number; label: string }[] = []
    let last = -1
    let lastCol = -99
    weeks.forEach((week, col) => {
      const first = week[0]
      if (!first) return
      const m = asDate(first.date).getMonth()
      if (m === last) return
      last = m
      // A label is about three columns wide. Two months starting within that of
      // each other would overlap into "JuAug", so the later one waits.
      if (col - lastCol < 3) return
      if (col >= weeks.length - 1) return
      out.push({ col, label: MONTHS[m] })
      lastCol = col
    })
    return out
  }, [weeks])

  const peakHour = useMemo(() => {
    let best = 0
    stats.byHour.forEach((n, h) => {
      if (n > stats.byHour[best]) best = h
    })
    return stats.byHour[best] > 0 ? best : null
  }, [stats.byHour])

  // Additions only, for bar, percentage and number alike. Mixing churn into
  // the percentage while showing additions beside it made a file with more
  // added lines read as a smaller share than one with fewer.
  const langTotal = stats.languages.reduce((n, l) => n + l.added, 0)

  return (
    <div className="stats">
      <header className="stats-head">
        <h1 className="stats-title">Stats</h1>
        <span className="stats-sub">
          {data === null
            ? 'Counting…'
            : scope
              ? shortPath(scope, home)
              : 'Every folder on this machine'}
        </span>

        <span className="spacer" />

        {folder && (
          <div className="stats-scope" role="group" aria-label="Which folders to count">
            <button
              className="stats-scope-btn"
              data-on={!everywhere}
              onClick={() => setEverywhere(false)}
              title="Only this workspace's folder"
            >
              <FolderOpen size={12} />
              This folder
            </button>
            <button
              className="stats-scope-btn"
              data-on={everywhere}
              onClick={() => setEverywhere(true)}
              title="Every folder you have worked in"
            >
              <Globe size={12} />
              Everywhere
            </button>
          </div>
        )}
      </header>

      <div className="stats-body">
        {/* What the agents spent, read from the transcripts themselves. */}
        <UsageOverview />

        {/* ---- the streak, which is the thing people actually come for ---- */}
        <section className="stats-streaks">
          <div className="streak-main">
            <Flame size={20} />
            <div>
              <div className="streak-n">{stats.currentStreak}</div>
              <div className="streak-label">
                day{stats.currentStreak === 1 ? '' : 's'} in a row
              </div>
            </div>
          </div>
          <div className="streak-side">
            <div>
              <div className="streak-n-sm">{stats.longestStreak}</div>
              <div className="streak-label">longest streak</div>
            </div>
            <div>
              <div className="streak-n-sm">{stats.activeDays}</div>
              <div className="streak-label">active days this year</div>
            </div>
          </div>
        </section>

        {/* ---- the grid ---- */}
        <section className="stats-card">
          <div className="stats-card-head">
            <span className="eyebrow">
              {stats.activeDays} day{stats.activeDays === 1 ? '' : 's'} of work in the last year
            </span>
            <span className="spacer" />
            <div className="stats-metrics">
              {METRICS.map((m) => (
                <button
                  key={m.id}
                  className="stats-metric"
                  data-on={metric === m.id}
                  onClick={() => setMetric(m.id)}
                  disabled={!stats.hasRepo && (m.id === 'commits' || m.id === 'lines')}
                  title={
                    !stats.hasRepo && (m.id === 'commits' || m.id === 'lines')
                      ? 'Needs a git repository'
                      : undefined
                  }
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="heatmap-wrap">
            <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, 13px)` }}>
              {monthLabels.map((m) => (
                <span key={`${m.col}-${m.label}`} style={{ gridColumnStart: m.col + 1 }}>
                  {m.label}
                </span>
              ))}
            </div>

            <div className="heatmap-rows">
              <div className="heatmap-days">
                <span>Mon</span>
                <span>Wed</span>
                <span>Fri</span>
              </div>

              <div className="heatmap" role="img" aria-label="Contribution grid for the last year">
                {weeks.map((week, i) => (
                  <div className="heatmap-week" key={i}>
                    {week.map((day) => (
                      <div
                        key={day.date}
                        className="heatmap-cell"
                        data-level={level(day)}
                        onMouseEnter={() => setHover(day)}
                        onMouseLeave={() => setHover(null)}
                        title={`${longDate(day.date)} — ${day.sessions} session${day.sessions === 1 ? '' : 's'}, ${day.commits} commit${day.commits === 1 ? '' : 's'}`}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="heatmap-foot">
            <span className="heatmap-readout">
              {hover ? (
                <>
                  <strong>{longDate(hover.date)}</strong>
                  {' — '}
                  {hover.sessions} session{hover.sessions === 1 ? '' : 's'}
                  {stats.hasRepo && (
                    <>
                      , {hover.commits} commit{hover.commits === 1 ? '' : 's'}
                      {hover.added + hover.removed > 0 && (
                        <>
                          {' '}
                          (+{compact(hover.added)} −{compact(hover.removed)})
                        </>
                      )}
                    </>
                  )}
                </>
              ) : (
                <span className="text-lo">
                  {stats.from && `${longDate(stats.from)} to ${longDate(stats.to)}`}
                </span>
              )}
            </span>
            <span className="spacer" />
            <span className="heatmap-legend">
              Less
              {[0, 1, 2, 3, 4].map((l) => (
                <i key={l} className="heatmap-cell" data-level={l} />
              ))}
              More
            </span>
          </div>
        </section>

        {/* ---- totals ---- */}
        <section className="stats-tiles">
          <div className="stats-tile">
            <MessagesSquare size={13} />
            <div className="tile-n">{compact(stats.totalSessions)}</div>
            <div className="tile-label">agent sessions</div>
          </div>
          <div className="stats-tile">
            <GitCommitHorizontal size={13} />
            <div className="tile-n">{compact(stats.totalCommits)}</div>
            <div className="tile-label">commits</div>
          </div>
          <div className="stats-tile">
            <Plus size={13} />
            <div className="tile-n tile-add">{compact(stats.linesAdded)}</div>
            <div className="tile-label">lines written</div>
          </div>
          <div className="stats-tile">
            <Minus size={13} />
            <div className="tile-n tile-del">{compact(stats.linesRemoved)}</div>
            <div className="tile-label">lines deleted</div>
          </div>
        </section>

        <div className="stats-split">
          {/* ---- languages ---- */}
          <section className="stats-card">
            <div className="stats-card-head">
              <span className="eyebrow">What you wrote it in</span>
            </div>
            {stats.languages.length === 0 ? (
              <p className="stats-none">
                {stats.hasRepo
                  ? 'No commits in this window yet.'
                  : 'Open a workspace on a git repository to see this.'}
              </p>
            ) : (
              <>
                <div className="lang-bar">
                  {stats.languages.map((l, i) => (
                    <span
                      key={l.label}
                      data-i={Math.min(i, 5)}
                      style={{ width: `${(l.added / Math.max(1, langTotal)) * 100}%` }}
                      title={`${l.label} — ${compact(l.added)} lines written`}
                    />
                  ))}
                </div>
                <ul className="lang-list">
                  {stats.languages.map((l, i) => (
                    <li key={l.label}>
                      <i data-i={Math.min(i, 5)} />
                      <span className="lang-name">{l.label}</span>
                      <span className="lang-pct">
                        {Math.round((l.added / Math.max(1, langTotal)) * 100)}%
                      </span>
                      <span className="lang-lines">+{compact(l.added)}</span>
                    </li>
                  ))}
                </ul>
                <p className="stats-note">
                  Lockfiles and build output are not counted — ten thousand lines from one
                  dependency bump would drown out everything you actually wrote.
                </p>
              </>
            )}
          </section>

          {/* ---- when you work ---- */}
          <section className="stats-card">
            <div className="stats-card-head">
              <span className="eyebrow">When you work</span>
              <span className="spacer" />
              {peakHour !== null && (
                <span className="stats-peak">
                  busiest around {peakHour % 12 === 0 ? 12 : peakHour % 12}
                  {peakHour < 12 ? 'am' : 'pm'}
                </span>
              )}
            </div>
            <div className="hours">
              {stats.byHour.map((n, h) => {
                const peak = Math.max(...stats.byHour, 1)
                return (
                  <div
                    key={h}
                    className="hour"
                    title={`${n} session${n === 1 ? '' : 's'} started at ${h}:00`}
                  >
                    <div className="hour-bar" style={{ height: `${Math.max(2, (n / peak) * 100)}%` }} />
                  </div>
                )
              })}
            </div>
            <div className="hours-axis">
              <span>12am</span>
              <span>6am</span>
              <span>noon</span>
              <span>6pm</span>
              <span>11pm</span>
            </div>
            {stats.busiest && (
              <p className="stats-note">
                Your biggest day was {longDate(stats.busiest.date)} — {stats.busiest.sessions} session
                {stats.busiest.sessions === 1 ? '' : 's'}
                {stats.hasRepo ? ` and ${stats.busiest.commits} commit${stats.busiest.commits === 1 ? '' : 's'}` : ''}.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
