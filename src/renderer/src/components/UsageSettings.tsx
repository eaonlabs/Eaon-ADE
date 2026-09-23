import { useState } from 'react'
import { BILLED_NOTE, TIER_LIMITS, formatTokens, limitsFor } from '@shared/usage'
import { useStore } from '../store/useStore'
import { CodexUsageCard } from './CodexUsageCard'

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className="toggle" data-on={on} onClick={() => onChange(!on)} role="switch"
      aria-checked={on} aria-label={label}>
      <i />
    </button>
  )
}

function Row({ name, desc, children }: { name: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-name">{name}</div>
        <div className="setting-desc">{desc}</div>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

export function UsageSettings(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const [tier, setTier] = useState('')

  const defaults = limitsFor(tier)

  return (
    <>
      <p className="settings-lede">
        The token counts are exact and nothing leaves this machine. What is <em>not</em> on disk
        anywhere is your plan's ceiling —
        Anthropic reports that per request — so the percentage is measured against a limit you set.
      </p>

      <div className="section-head">
        <span className="eyebrow">Where the numbers come from</span>
      </div>

      <Row
        name="Ask Anthropic for the real figures"
        desc="Gives the exact percentages instead of an estimate. Turning this on lets Eaon ADE read the sign-in token out of Claude Code's credentials and make one request as you, each time it refreshes. Off, nothing but your own transcripts is ever read."
      >
        <Toggle
          on={settings.usageFromAnthropic}
          onChange={(v) => update({ usageFromAnthropic: v })}
          label="Ask Anthropic for usage"
        />
      </Row>

      {!settings.usageFromAnthropic && (
        <>
          <div className="section-head" style={{ marginTop: 22 }}>
            <span className="eyebrow">What the percentage is measured against</span>
          </div>

          <Row
            name="Five-hour limit"
            desc="Billed tokens in a rolling five hours. Leave at 0 to use your plan's default."
          >
            <input
              className="select mono"
              style={{ width: 130 }}
              type="number"
              min={0}
              step={1000000}
              value={settings.usageSessionLimit}
              onChange={(e) => update({ usageSessionLimit: Math.max(0, Number(e.target.value) || 0) })}
              aria-label="Five-hour limit"
            />
          </Row>

          <Row
            name="Weekly limit"
            desc="Billed tokens in a rolling seven days. Leave at 0 to use your plan's default."
          >
            <input
              className="select mono"
              style={{ width: 130 }}
              type="number"
              min={0}
              step={10000000}
              value={settings.usageWeekLimit}
              onChange={(e) => update({ usageWeekLimit: Math.max(0, Number(e.target.value) || 0) })}
              aria-label="Weekly limit"
            />
          </Row>

          <p className="setting-desc" style={{ lineHeight: 1.7, marginTop: 4 }}>
            Defaults per plan are {Object.keys(TIER_LIMITS).length} rows of starting points, not
            published figures — Anthropic states subscription limits in prompts rather than tokens,
            and the real ceiling moves with demand. Yours currently resolves to{' '}
            <span className="mono">{formatTokens(defaults.session)}</span> per five hours and{' '}
            <span className="mono">{formatTokens(defaults.week)}</span> per week. Set your own once
            you have watched where you actually run out.
          </p>

          <p className="setting-desc" style={{ lineHeight: 1.7, marginTop: 12 }}>
            {BILLED_NOTE} A single message here read 785,779 cached tokens against 2,255 written, so
            counting cache reads in the total would make it move with how long a conversation is
            rather than with how much work was asked for.
          </p>
        </>
      )}

      <CodexUsageCard />

      <Row name="Forget what was scanned" desc="Reads every transcript again from the beginning. Only useful if the numbers look wrong.">
        <button
          className="btn"
          onClick={() => {
            window.eaon.usage.forget()
            setTier((t) => t)
          }}
        >
          Rescan
        </button>
      </Row>
    </>
  )
}
