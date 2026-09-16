import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, Check, Loader, Plug, RefreshCw, TriangleAlert } from 'lucide-react'
import {
  PROVIDERS,
  type ProviderDef,
  type ProviderState,
  type ProviderStatus
} from '@shared/integrations'
import { hasProviderMark, ProviderMark } from './ProviderMarks'

/**
 * Connected services, in Settings.
 *
 * Nothing here is a credential store. Eaon reads what your shell already has —
 * a signed-in `gh`, a token exported in your profile — and reports which of the
 * two it found. That is why there is no field to type a token into: the value
 * never leaves the main process, and a panel that could show it would be a
 * panel that could leak it.
 */

const STATUS_LABEL: Record<ProviderStatus, string> = {
  connected: 'Connected',
  'needs-auth': 'Needs sign-in',
  'not-installed': 'Not installed',
  'not-configured': 'Not set up'
}

function StatusPill({ status }: { status: ProviderStatus }): React.JSX.Element {
  return (
    <span className="ig-pill" data-status={status}>
      {status === 'connected' ? (
        <Check size={12} aria-hidden="true" />
      ) : status === 'needs-auth' ? (
        <TriangleAlert size={12} aria-hidden="true" />
      ) : null}
      {STATUS_LABEL[status]}
    </span>
  )
}

function Card({ def, state }: { def: ProviderDef; state?: ProviderState }): React.JSX.Element {
  const status = state?.status ?? 'not-configured'
  const open = (url: string): void => window.eaon.sys.openExternal(url)

  return (
    <div className="ig-card" data-status={status}>
      <span className="ig-mark" aria-hidden="true">
        {hasProviderMark(def.id) ? <ProviderMark id={def.id} size={17} /> : def.name.slice(0, 1)}
      </span>

      <span className="ig-body">
        <span className="ig-name">
          {def.name}
          {state?.account && <span className="ig-account">{state.account}</span>}
        </span>
        <span className="ig-blurb">{def.blurb}</span>

        {state && <span className="ig-detail">{state.detail}</span>}

        {/*
         * Variable names, struck through when unset. This is the part that
         * makes a half-configured provider diagnosable without ever printing
         * what any of them hold.
         */}
        {state && state.env.length > 0 && (
          <span className="ig-envs">
            {state.env.map((flag) => (
              <span key={flag.name} className="ig-env" data-set={flag.set} title={flag.name}>
                {flag.name}
              </span>
            ))}
          </span>
        )}
      </span>

      <span className="ig-side">
        <StatusPill status={status} />
        {status === 'not-installed' && def.installHint && (
          <code className="ig-hint">{def.installHint}</code>
        )}
        <button className="ig-link" onClick={() => open(def.docs)} title={`Open ${def.name} docs`}>
          Docs
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      </span>
    </div>
  )
}

export function IntegrationsPanel(): React.JSX.Element {
  const [states, setStates] = useState<ProviderState[]>([])
  const [busy, setBusy] = useState(true)

  const load = useCallback(async (hard: boolean): Promise<void> => {
    setBusy(true)
    try {
      const next = hard
        ? await window.eaon.integrations.refresh()
        : await window.eaon.integrations.list()
      setStates(next)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const byId = new Map(states.map((s) => [s.id, s]))
  const connected = states.filter((s) => s.status === 'connected').length

  return (
    <div className="integrations">
      <div className="section-head">
        <span className="eyebrow">Integrations</span>
        <span className="section-note">
          {busy && !states.length ? 'checking…' : `${connected} of ${PROVIDERS.length} connected`}
        </span>
      </div>
      <p className="settings-lede">
        Eaon reads what is already on your machine and never stores a credential of its own.
      </p>

      <div className="ig-list">
        {PROVIDERS.map((def) => (
          <Card key={def.id} def={def} state={byId.get(def.id)} />
        ))}
      </div>

      <div className="ig-foot">
        <button className="ig-refresh" onClick={() => void load(true)} disabled={busy}>
          {busy ? (
            <Loader size={13} className="spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={13} aria-hidden="true" />
          )}
          Re-check
        </button>
        <span className="ig-foot-note">
          <Plug size={12} aria-hidden="true" />
          Sign in with the provider’s own CLI, or export its token in your shell profile.
        </span>
      </div>
    </div>
  )
}
