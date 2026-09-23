import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { relTime } from '../lib/util'
import { useStore } from '../store/useStore'

/** Live update status and a manual check, for Settings › About. */
export function UpdateSetting(): React.JSX.Element {
  const update = useStore((s) => s.update)
  const dismissUpdate = useStore((s) => s.dismissUpdate)
  const version = useStore((s) => s.appVersion)
  const [checking, setChecking] = useState(false)

  const status = (): React.JSX.Element => {
    switch (update.phase) {
      case 'checking':
        return <>Checking…</>
      case 'downloading':
        return (
          <>
            Downloading <b>{update.version}</b> · {Math.round(update.percent)}%
          </>
        )
      case 'ready':
        return (
          <>
            <b>{update.version}</b> ready to install
          </>
        )
      case 'error':
        return <>Could not check — {update.error}</>
      case 'unsupported':
        // Running from source, a build with no release feed behind it, or a
        // Linux package whose updates belong to apt/dnf rather than to us.
        return <>{update.unsupportedReason ?? 'Not available in this build'}</>
      default:
        return (
          <>
            <b>{version}</b> is the latest
            {update.lastCheckedAt ? ` · checked ${relTime(update.lastCheckedAt)}` : ''}
          </>
        )
    }
  }

  const busy = checking || update.phase === 'checking' || update.phase === 'downloading'

  return (
    <div className="update-row">
      <span className="update-status">{status()}</span>
      {update.phase === 'ready' ? (
        <button className="btn btn-primary" style={{ height: 30 }} onClick={() => dismissUpdate(null)}>
          Show
        </button>
      ) : (
        <button
          className="btn"
          style={{ height: 30 }}
          disabled={busy || update.phase === 'unsupported'}
          onClick={async () => {
            setChecking(true)
            try {
              await window.eaon.update.check()
            } finally {
              setChecking(false)
            }
          }}
        >
          <RefreshCw size={13} />
          {busy ? 'Checking…' : 'Check now'}
        </button>
      )}
    </div>
  )
}
