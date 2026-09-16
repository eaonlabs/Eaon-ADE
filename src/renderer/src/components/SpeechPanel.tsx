import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Play, Sparkles } from 'lucide-react'
import {
  QUALITY_LABEL,
  RATE_MAX,
  RATE_MIN,
  onlyCompactVoices,
  sortForPicker,
  type SystemVoice
} from '@shared/speech'
import { useStore } from '../store/useStore'
import { listVoices, preview, speechSupported } from '../lib/speech'

function Row({
  name,
  desc,
  children
}: {
  name: string
  desc: string
  children: React.ReactNode
}): React.JSX.Element {
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

function Toggle({
  on,
  onChange,
  label
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
}): React.JSX.Element {
  return (
    <button
      className="toggle"
      data-on={on}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label={label}
    >
      <i />
    </button>
  )
}

export function SpeechPanel(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)

  const [voices, setVoices] = useState<SystemVoice[]>([])
  const [supported, setSupported] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    void speechSupported().then((ok) => {
      if (!live) return
      setSupported(ok)
      if (!ok) return
      // Refreshed rather than read from cache: opening this panel is usually
      // what somebody does straight after downloading a voice.
      void listVoices(true).then((list) => live && setVoices(list))
    })
    return () => {
      live = false
    }
  }, [])

  const options = useMemo(() => sortForPicker(voices), [voices])
  const chosen = voices.find((v) => v.id === settings.speakVoice) ?? null
  const needsBetterVoice = voices.length > 0 && onlyCompactVoices(voices)

  if (supported === false) {
    return (
      <>
        <p className="settings-lede">
          Spoken alerts use the operating system's own speech synthesiser. This build is not
          running on macOS, so there is nothing here to turn on.
        </p>
      </>
    )
  }

  return (
    <>
      <p className="settings-lede">
        The pane names the one that stopped — “Ada has finished.” The voice is your Mac's own, so
        nothing is downloaded and nothing is sent anywhere.
      </p>

      <Row
        name="Say when an agent finishes"
        desc="Announces the pane by name once it has been quiet for a moment. Off until you ask for it."
      >
        <Toggle
          on={settings.speakOnFinish}
          onChange={(v) => update({ speakOnFinish: v })}
          label="Say when an agent finishes"
        />
      </Row>

      <Row
        name="Only when I am not watching"
        desc="Stay quiet if the pane that finished is the one already on screen and in focus."
      >
        <Toggle
          on={settings.speakOnlyWhenAway}
          onChange={(v) => update({ speakOnlyWhenAway: v })}
          label="Only when I am not watching"
        />
      </Row>

      <div className="section-head" style={{ marginTop: 24 }}>
        <span className="eyebrow">Voice</span>
        <span className="section-note">
          {voices.length ? `${options.length} worth using` : 'reading the system list'}
        </span>
      </div>

      <Row name="Voice" desc="Every voice installed on this Mac that suits a spoken line.">
        <select
          className="select"
          style={{ maxWidth: 240 }}
          value={settings.speakVoice}
          onChange={(e) => update({ speakVoice: e.target.value })}
          aria-label="Voice"
        >
          <option value="">Best available</option>
          {options.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · {QUALITY_LABEL[v.quality]} · {v.locale.replace('_', '-')}
            </option>
          ))}
        </select>
        <button
          className="btn"
          onClick={() => void preview(settings)}
          title="Hear it"
          aria-label="Hear the voice"
        >
          <Play size={12} />
          Hear it
        </button>
      </Row>

      <Row name="Speed" desc="Words per minute. The system default is about 175.">
        <input
          className="slider"
          type="range"
          min={RATE_MIN}
          max={RATE_MAX}
          step={5}
          value={settings.speakRate}
          onChange={(e) => update({ speakRate: Number(e.target.value) })}
          aria-label="Speaking speed"
        />
        <span className="chip mono">{settings.speakRate}</span>
      </Row>

      <Row name="Volume" desc="Relative to your system volume.">
        <input
          className="slider"
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(settings.speakVolume * 100)}
          onChange={(e) => update({ speakVolume: Number(e.target.value) / 100 })}
          aria-label="Volume"
        />
        <span className="chip mono">{Math.round(settings.speakVolume * 100)}%</span>
      </Row>

      {needsBetterVoice && (
        <div className="speech-hint">
          <Sparkles size={14} />
          <div>
            <strong>This Mac only has the basic voices.</strong>
            <p>
              They are the clipped, synthetic ones, and they sound it. macOS has far better
              versions of Ava, Zoe, Evan and Serena — marked <em>Premium</em> or{' '}
              <em>Enhanced</em> — but Apple downloads those on request and only offers them
              through System Settings. The button below opens Accessibility; from there it is{' '}
              <em>Spoken Content → System Voice → Manage Voices</em>. Anything you install shows
              up in the list above straight away.
            </p>
            <button className="btn" onClick={() => window.eaon.speech.openVoiceSettings()}>
              <ExternalLink size={12} />
              Open Accessibility settings
            </button>
          </div>
        </div>
      )}

      {chosen && chosen.quality !== 'compact' && (
        <p className="setting-desc" style={{ marginTop: 14 }}>
          {chosen.name} is a {QUALITY_LABEL[chosen.quality].toLowerCase()} voice — the good kind.
        </p>
      )}

      <div className="section-head" style={{ marginTop: 24 }}>
        <span className="eyebrow">When it speaks</span>
      </div>

      <p className="setting-desc" style={{ lineHeight: 1.7 }}>
        Only panes running an agent are announced — a plain shell goes quiet after every command
        and would never stop talking. A run has to have lasted a few seconds after the last thing
        you typed, which is what keeps it from reading your pauses back to you while you compose a
        prompt. The same pane will not be announced twice inside twenty seconds, and a pane says
        nothing at all for the first few seconds after it starts, while the agent is still printing
        its banner.
      </p>
    </>
  )
}
