import { useEffect, useState } from 'react'
import { FileCode2, Plus, Server, Trash2 } from 'lucide-react'
import { hostLabel, hostKeyOf, type SshHost } from '@shared/ssh'
import { useStore } from '../store/useStore'

/**
 * Remote targets, in Settings.
 *
 * Two lists, kept apart because they are owned by different people. The first
 * is `~/.ssh/config` — the user's own file, read fresh every time and never
 * copied here, so a change made in an editor shows up on the next look with
 * nothing to re-save. The second is boxes typed in here, which have nowhere
 * else to live.
 *
 * Connection details only. There is no passphrase field anywhere in this
 * feature: a remote pane runs the real `ssh` binary in a real terminal, and
 * whatever `ssh-agent` or the Keychain already holds is what authenticates it.
 * If a key needs unlocking the prompt appears in that terminal and is typed
 * into directly, exactly as it would be anywhere else.
 */

let seq = 0

function manualHost(input: {
  label: string
  hostname: string
  user: string
  port: string
  identityFile: string
}): SshHost | null {
  const hostname = input.hostname.trim()
  if (!hostname) return null
  seq += 1
  const port = input.port.trim()
  const host: SshHost = {
    id: `manual:${Date.now().toString(36)}${seq}`,
    label: input.label.trim(),
    hostname,
    user: input.user.trim() || null,
    port: /^\d+$/.test(port) ? Number(port) : null,
    identityFile: input.identityFile.trim() || null,
    source: 'manual',
    alias: null
  }
  host.label = hostLabel(host)
  return host
}

function Row({
  host,
  onRemove
}: {
  host: SshHost
  onRemove?: () => void
}): React.JSX.Element {
  const detail = [
    host.user ? `${host.user}@${host.hostname}` : host.hostname,
    host.port ? `port ${host.port}` : null,
    host.identityFile ? host.identityFile.replace(/^.*\//, '') : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="host-row">
      <span className="host-mark" aria-hidden="true">
        {host.source === 'config' ? <FileCode2 size={14} /> : <Server size={14} />}
      </span>
      <span className="host-body">
        <span className="host-name">{hostLabel(host)}</span>
        <span className="host-meta">{detail}</span>
      </span>
      {onRemove && (
        <button
          className="icon-btn"
          onClick={onRemove}
          title="Forget this host"
          aria-label={`Forget ${hostLabel(host)}`}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

export function HostsPanel(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)

  const [configHosts, setConfigHosts] = useState<SshHost[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({
    label: '',
    hostname: '',
    user: '',
    port: '',
    identityFile: ''
  })

  useEffect(() => {
    let live = true
    window.eaon.ssh
      .listConfigHosts()
      .then((h) => {
        if (live) setConfigHosts(h)
      })
      .catch(() => {
        if (live) setConfigHosts([])
      })
    return () => {
      live = false
    }
  }, [])

  const saved = settings.sshHosts ?? []

  const add = (): void => {
    const host = manualHost(draft)
    if (!host) return
    // The same box twice is a list that grows and never gets shorter.
    const key = hostKeyOf(host)
    const rest = saved.filter((h) => hostKeyOf(h) !== key)
    updateSettings({ sshHosts: [...rest, host] })
    setDraft({ label: '', hostname: '', user: '', port: '', identityFile: '' })
    setAdding(false)
  }

  return (
    <div className="hosts">
      <div className="section-head">
        <span className="eyebrow">From ~/.ssh/config</span>
        <span className="section-note">
          {configHosts === null ? 'reading…' : `${configHosts.length} found`}
        </span>
      </div>
      <p className="settings-lede">
        A workspace on one of these connects by alias, so ProxyJump, extra keys and anything else
        you have configured keep working.
      </p>

      {configHosts !== null && configHosts.length === 0 ? (
        <p className="stats-none">
          Nothing in <code>~/.ssh/config</code> yet. Anything you add there appears here.
        </p>
      ) : (
        <div className="host-list">
          {(configHosts ?? []).map((h) => (
            <Row key={h.id} host={h} />
          ))}
        </div>
      )}

      <div className="section-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Added here</span>
        <span className="section-note">{saved.length} saved</span>
      </div>
      <p className="settings-lede">
        For boxes that are not in your ssh config. Kept so the setup wizard offers them again.
      </p>

      {saved.length > 0 && (
        <div className="host-list">
          {saved.map((h) => (
            <Row
              key={h.id}
              host={h}
              onRemove={() =>
                updateSettings({ sshHosts: saved.filter((x) => x.id !== h.id) })
              }
            />
          ))}
        </div>
      )}

      {adding ? (
        <div className="host-form">
          <label>
            <span>Host</span>
            <input
              autoFocus
              value={draft.hostname}
              placeholder="build.example.com"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, hostname: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
          </label>
          <label>
            <span>User</span>
            <input
              value={draft.user}
              placeholder="optional"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, user: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
          </label>
          <label>
            <span>Port</span>
            <input
              value={draft.port}
              placeholder="22"
              inputMode="numeric"
              onChange={(e) => setDraft({ ...draft, port: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
          </label>
          <label className="host-form-wide">
            <span>Key file</span>
            <input
              value={draft.identityFile}
              placeholder="optional — ssh picks one otherwise"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, identityFile: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
          </label>
          <div className="host-form-foot">
            <span className="stats-note">
              Nothing is connected to now — the first attempt is the terminal that opens.
            </span>
            <button className="btn btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!draft.hostname.trim()} onClick={add}>
              Save host
            </button>
          </div>
        </div>
      ) : (
        <button className="btn host-add" onClick={() => setAdding(true)}>
          <Plus size={14} />
          Add a host
        </button>
      )}
    </div>
  )
}
