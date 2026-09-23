import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader, RefreshCw } from 'lucide-react'
import {
  EMPTY_TOKEN_USAGE,
  USAGE_RANGES,
  compactTokens,
  money,
  shortDay,
  type TokenUsage,
  type UsageMetric,
  type UsageRange
} from '@shared/token-usage'

/**
 * What the agents spent, over a window you choose.
 *
 * Every count here is read from the transcripts the agents wrote as they
 * worked, so it is counted rather than sampled and it covers every agent this
 * machine has run rather than one plan's rolling window.
 *
 * The money is the one estimate, and the surface says so in three places
 * rather than printing a dollar sign and leaving you to assume: a subscription
 * does not bill per token at all, so the figure answers "what this would have
 * cost through the API" and never "what you owe".
 */

/** The chart's own proportions. Drawn in these units and scaled by the box. */
const W = 720
const H = 150

/**
 * A path through the points, as straight segments.
 *
 * Deliberately not smoothed. A spline through daily totals invents days that
 * did not happen — it overshoots below zero after a busy day beside a quiet
 * one, which on this data is most days.
 */
function linePath(values: number[], max: number): string {
  if (values.length === 0) return ''
  const step = values.length > 1 ? W / (values.length - 1) : 0
  return values
    .map((v, i) => {
      const x = i * step
      const y = H - (max > 0 ? (v / max) * H : 0)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function areaPath(values: number[], max: number): string {
  const line = linePath(values, max)
  if (!line) return ''
  return `${line} L${W},${H} L0,${H} Z`
}

/**
 * Four gridlines whose labels are all round numbers.
 *
 * The axis is labelled in thirds, so it is the *third* that has to be round
 * rather than the top: picking a tidy-looking 1000 for a peak of 870 gives
 * gridlines at 333 and 667. Rounding the third up instead and taking three of
 * it reads $900 / $600 / $300 / $0, and the line still has headroom.
 */
function niceMax(peak: number): number {
  if (peak <= 0) return 1
  const third = peak / 3
  const mag = 10 ** Math.floor(Math.log10(third))
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (third <= step * mag) return step * mag * 3
  }
  return 10 * mag * 3
}

/**
 * The model id, without the build date some of them carry.
 *
 * `claude-haiku-4-5-20251001` is the same model as `claude-haiku-4-5` and the
 * date only ever costs the column the width it needs to stay unclipped.
 */
function modelId(model: string): string {
  return model.replace(/-\d{8}$/, '')
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tu-stat">
      <div className="tu-stat-label">{label}</div>
      <div className="tu-stat-value">
        {value}
        {sub && <span className="tu-stat-sub"> · {sub}</span>}
      </div>
    </div>
  )
}

export function UsageOverview(): React.JSX.Element {
  const [range, setRange] = useState<UsageRange>(30)
  const [metric, setMetric] = useState<UsageMetric>('cost')
  const [usage, setUsage] = useState<TokenUsage>(EMPTY_TOKEN_USAGE)
  const [busy, setBusy] = useState(true)

  const load = useCallback(
    async (r: UsageRange): Promise<void> => {
      setBusy(true)
      try {
        setUsage(await window.eaon.usage.tokens(r))
      } finally {
        setBusy(false)
      }
    },
    []
  )

  useEffect(() => {
    let live = true
    void window.eaon.usage.tokens(range).then((u) => {
      if (live) {
        setUsage(u)
        setBusy(false)
      }
    })
    return () => {
      live = false
    }
  }, [range])

  const isCost = metric === 'cost'
  const series = useMemo(
    () => usage.days.map((d) => (isCost ? d.cost : d.tokens)),
    [usage.days, isCost]
  )
  const max = useMemo(() => niceMax(Math.max(...series, 0)), [series])
  const value = (n: number): string => (isCost ? money(n) : compactTokens(n))

  const total = isCost ? usage.cost : usage.tokens
  const topWorkspace = usage.workspaces[0]

  if (!busy && usage.tokens === 0) {
    return (
      <section className="stats-card">
        <div className="stats-card-head">
          <span className="eyebrow">Token usage</span>
        </div>
        <p className="stats-none">
          Nothing in the last {range} days. This reads the transcripts your agents write as they
          work, so it fills in as soon as one runs.
        </p>
      </section>
    )
  }

  return (
    <section className="tu">
      <header className="tu-head">
        <span className="eyebrow">Token usage</span>
        <span className="tu-window">
          {usage.from ? `${shortDay(usage.from)} – ${shortDay(usage.to)}` : `Last ${range} days`}
          <span className="tu-sep">·</span>
          API-rate estimate from local session logs
        </span>

        <div className="tu-controls">
          <div className="tu-seg" role="group" aria-label="What to show">
            {(['cost', 'tokens'] as UsageMetric[]).map((m) => (
              <button key={m} data-on={metric === m} onClick={() => setMetric(m)}>
                {m === 'cost' ? 'Cost' : 'Tokens'}
              </button>
            ))}
          </div>
          <div className="tu-seg" role="group" aria-label="Over how long">
            {USAGE_RANGES.map((r) => (
              <button key={r} data-on={range === r} onClick={() => setRange(r)}>
                {r}d
              </button>
            ))}
          </div>
          <button
            className="icon-btn"
            onClick={() => void load(range)}
            disabled={busy}
            title="Read the transcripts again"
            aria-label="Read the transcripts again"
          >
            <RefreshCw size={13} className={busy ? 'spin' : undefined} />
          </button>
        </div>
      </header>

      <div className="tu-body">
        <div className="tu-headline">
          <div className="tu-total">
            {value(total)}
            {isCost && <span className="tu-star">*</span>}
          </div>
          {isCost ? (
            <>
              <p className="tu-foot">* If billed at full API rate</p>
              {/* The figure above is what the API would have charged. On a
                  subscription it is not a bill, and saying so is the whole
                  point of showing both lines. */}
              <p className="tu-free">Cost to you: $0</p>
            </>
          ) : (
            <p className="tu-foot">Input, output, cache writes and reads</p>
          )}

          <ul className="tu-legend">
            {usage.providers.map((p) => (
              <li key={p.id}>
                <i className="tu-swatch" />
                <span className="tu-legend-name">{p.label}</span>
                <span className="tu-legend-n">{value(isCost ? p.cost : p.tokens)}</span>
                <span className="tu-legend-pct">{Math.round(p.share)}%</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="tu-chart">
          <div className="tu-axis">
            {/* Exact thirds, not 0.66: the whole point of rounding the third
                up in niceMax is lost if the label is then 594 rather than 600. */}
            {[1, 2 / 3, 1 / 3, 0].map((f) => (
              <span key={f}>{value(max * f)}</span>
            ))}
          </div>
          <div className="tu-plot">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
              aria-label={`${isCost ? 'Cost' : 'Tokens'} per day over ${range} days`}>
              {[1 / 3, 2 / 3].map((f) => (
                <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="tu-grid" />
              ))}
              <path d={areaPath(series, max)} className="tu-area" />
              <path d={linePath(series, max)} className="tu-line" />
            </svg>
            <div className="tu-xaxis">
              <span>{usage.from && shortDay(usage.from)}</span>
              <span>{usage.days.length > 2 && shortDay(usage.days[Math.floor(usage.days.length / 2)].date)}</span>
              <span>{usage.to && shortDay(usage.to)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="tu-stats">
        <Stat label="Processed tokens" value={compactTokens(usage.tokens)} />
        <Stat
          label="Cached input"
          value={compactTokens(usage.cachedInput)}
          sub={`${Math.round(usage.cachedShare)}%`}
        />
        <Stat label="Uncached input" value={compactTokens(usage.uncachedInput)} />
        <Stat label="Output" value={compactTokens(usage.output)} />
        <Stat
          label="Cache savings"
          value={money(usage.cacheSavings)}
          sub={`${usage.cacheMultiple.toFixed(1)}x`}
        />
      </div>

      <div className="tu-tables">
        <table className="tu-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="tu-num">Cost</th>
              <th className="tu-num">Share</th>
              <th className="tu-num">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {usage.models.map((m) => (
              <tr key={m.model}>
                <td title={m.model}>
                  <i className="tu-swatch" />
                  {modelId(m.model)}
                </td>
                <td className="tu-num">{money(m.cost)}</td>
                <td className="tu-num tu-dim">{Math.round(m.share)}%</td>
                <td className="tu-num tu-dim">{compactTokens(m.tokens)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="tu-num">~{money(usage.cost)}</td>
              <td className="tu-num tu-dim">100%</td>
              <td className="tu-num tu-dim">{compactTokens(usage.tokens)}</td>
            </tr>
          </tfoot>
        </table>

        <table className="tu-table">
          <thead>
            <tr>
              <th>Workspace</th>
              <th className="tu-num tu-all">
                All {usage.workspaceCount}
              </th>
              <th className="tu-num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {usage.workspaces.map((w) => (
              <tr key={w.path}>
                <td title={w.path}>
                  <span className="tu-ws-name">{w.name}</span>
                  {/* Share of the busiest project, so the eye can rank them
                      without reading every number. */}
                  <i
                    className="tu-ws-bar"
                    style={{
                      width: `${topWorkspace && topWorkspace.cost > 0 ? Math.max(1, (w.cost / topWorkspace.cost) * 100) : 0}%`
                    }}
                  />
                </td>
                <td className="tu-num tu-dim">{compactTokens(w.tokens)}</td>
                <td className="tu-num">{money(w.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {busy && (
        <p className="tu-reading">
          <Loader size={12} className="spin" />
          Reading the transcripts…
        </p>
      )}
    </section>
  )
}
