import { useEffect, useState } from 'react'
import { Check, Download, FolderOpen, Trash2, X } from 'lucide-react'
import {
  STT_LANGUAGES,
  STT_MODELS,
  VOICE_HOLD_KEYS,
  holdKeyLabel,
  findModel,
  formatBytes,
  type SttModelDef,
  type SttSpeed
} from '@shared/stt'
import { useStore } from '../store/useStore'
import { MOD } from '../lib/util'

const SPEED_LABEL: Record<SttSpeed, string> = {
  instant: 'Fastest',
  fast: 'Fast',
  balanced: 'Balanced',
  accurate: 'Most accurate'
}

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

function ModelCard({ model }: { model: SttModelDef }): React.JSX.Element {
  const installed = useStore((s) => s.sttInstalled.find((m) => m.id === model.id))
  const progress = useStore((s) => s.sttProgress[model.id])
  const inUse = useStore((s) => s.settings.voiceModelId === model.id)
  const update = useStore((s) => s.updateSettings)
  const download = useStore((s) => s.downloadModel)
  const remove = useStore((s) => s.removeModel)

  const busy = Boolean(progress && !progress.done)
  const ready = Boolean(installed?.complete)
  const pct = busy && progress.total > 0 ? (progress.received / progress.total) * 100 : 0

  return (
    <div className="model-card" data-on={inUse && ready}>
      <div className="model-head">
        <div className="model-titles">
          <div className="model-name">
            {model.label}
            {model.recommended && <span className="model-tag">recommended</span>}
          </div>
          <div className="model-blurb">{model.blurb}</div>
        </div>

        <div className="model-actions">
          {ready && !busy && (
            <>
              {inUse ? (
                <span className="model-inuse">
                  <Check size={12} /> In use
                </span>
              ) : (
                <button className="btn" onClick={() => update({ voiceModelId: model.id })}>
                  Use
                </button>
              )}
              <button
                className="icon-btn"
                title={`Delete ${model.label}`}
                aria-label={`Delete ${model.label}`}
                onClick={() => {
                  if (window.confirm(`Delete ${model.label}? You can download it again later.`)) {
                    void remove(model.id)
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            </>
          )}

          {!ready && !busy && (
            <button className="btn btn-primary" onClick={() => void download(model.id)}>
              <Download size={12} />
              {formatBytes(model.size)}
            </button>
          )}

          {busy && (
            <button
              className="icon-btn"
              onClick={() => window.eaon.stt.cancel(model.id)}
              title="Cancel download"
              aria-label="Cancel download"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="model-facts">
        <span className="chip">{SPEED_LABEL[model.speed]}</span>
        <span className="chip">{model.realtime} realtime</span>
        <span className="chip">{model.multilingual ? '99 languages' : 'English only'}</span>
        <span className="chip mono">{formatBytes(ready && installed ? installed.bytes : model.size)}</span>
      </div>

      {busy && (
        <div className="model-progress">
          <div className="model-bar">
            <i style={{ width: `${Math.min(100, pct).toFixed(1)}%` }} />
          </div>
          <div className="model-progress-note">
            {formatBytes(progress.received)} of {formatBytes(progress.total)}
            {progress.file ? ` · ${progress.file.replace(/^onnx\//, '')}` : ''}
          </div>
        </div>
      )}

      {!ready && !busy && installed && installed.bytes > 0 && (
        <div className="model-progress-note">
          Part of this model is on disk. Downloading again picks up where it stopped.
        </div>
      )}
    </div>
  )
}

export function VoicePanel(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const installed = useStore((s) => s.sttInstalled)

  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [dir, setDir] = useState('')
  const isMac = navigator.userAgent.includes('Mac')

  useEffect(() => {
    void window.eaon.stt.dir().then(setDir)
    const load = (): void => {
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((all) => setMics(all.filter((d) => d.kind === 'audioinput')))
        .catch(() => setMics([]))
    }
    load()
    navigator.mediaDevices?.addEventListener('devicechange', load)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load)
  }, [])

  const chosen = findModel(settings.voiceModelId)
  const onDisk = installed.reduce((n, m) => n + m.bytes, 0)
  // Labels stay blank until the microphone has been used once.
  const named = mics.some((m) => m.label)

  return (
    <>
      <p className="settings-lede">
        Download a model once — no account, no API key, no audio sent anywhere. Hold{' '}
        <span className="kbd">{holdKeyLabel(settings.voiceHoldKey, isMac)}</span> and speak, or
        press <span className="kbd">{MOD}⇧D</span> to start and stop by hand. Either way the
        words land wherever you were already typing.
      </p>

      <div className="section-head">
        <span className="eyebrow">Models</span>
        <span className="section-note">
          {onDisk > 0 ? `${formatBytes(onDisk)} on disk` : 'nothing downloaded yet'}
        </span>
      </div>

      <div className="model-list">
        {STT_MODELS.map((m) => (
          <ModelCard key={m.id} model={m} />
        ))}
      </div>

      <div className="section-head" style={{ marginTop: 24 }}>
        <span className="eyebrow">How it listens</span>
      </div>

      <Row name="Microphone" desc="Which input to record from.">
        <select
          className="select"
          style={{ maxWidth: 240 }}
          value={settings.voiceMicId}
          onChange={(e) => update({ voiceMicId: e.target.value })}
        >
          <option value="">System default</option>
          {mics.map((m, i) => (
            <option key={m.deviceId} value={m.deviceId}>
              {m.label || `Microphone ${i + 1}`}
            </option>
          ))}
        </select>
      </Row>
      {!named && mics.length > 0 && (
        <p className="setting-desc" style={{ marginTop: -6, marginBottom: 14 }}>
          Microphone names appear after the first time you dictate.
        </p>
      )}

      <Row
        name="Language"
        desc={
          chosen && !chosen.multilingual
            ? `${chosen.label} is English-only, so this does not apply.`
            : 'Naming the language is more reliable than letting the model guess.'
        }
      >
        <select
          className="select"
          value={settings.voiceLanguage}
          disabled={Boolean(chosen && !chosen.multilingual)}
          onChange={(e) => update({ voiceLanguage: e.target.value })}
        >
          {STT_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </Row>

      <Row name="Stop after silence" desc="How long a pause ends the recording by itself.">
        <select
          className="select"
          value={settings.voiceSilenceMs}
          onChange={(e) => update({ voiceSilenceMs: Number(e.target.value) })}
        >
          <option value={0}>Never — I'll stop it</option>
          <option value={1000}>1 second</option>
          <option value={1500}>1.5 seconds</option>
          <option value={2500}>2.5 seconds</option>
          <option value={4000}>4 seconds</option>
        </select>
      </Row>

      <Row
        name="Hold to talk"
        desc="Hold this key and speak; let go and the words land. Right-hand modifiers are free — nothing else in ADE uses one on its own."
      >
        <select
          className="select"
          value={settings.voiceHoldKey}
          onChange={(e) => update({ voiceHoldKey: e.target.value })}
        >
          {VOICE_HOLD_KEYS.map((k) => (
            <option key={k.code || 'none'} value={k.code}>
              {isMac ? k.mac : k.other}
            </option>
          ))}
        </select>
      </Row>

      <p className="setting-desc" style={{ marginTop: -6, marginBottom: 14 }}>
        The Fn / 🌐 key cannot be used. macOS never passes it to an application,
        so no app can see it without a system-wide input monitor and the
        permission that comes with it.
      </p>

      <div className="section-head" style={{ marginTop: 24 }}>
        <span className="eyebrow">What it does with the words</span>
      </div>

      <p className="setting-desc" style={{ lineHeight: 1.7, marginBottom: 18 }}>
        Dictation types for you and stops there. Your words go onto the prompt
        exactly as you said them — nothing is reworded, no filler is stripped, no
        punctuation is invented — and they stay there. Read them back, edit
        anything that came out wrong, and press Return yourself when you are
        ready. Nothing reaches an agent until you send it.
      </p>

      <Row name="Where models are kept" desc="Delete this folder and every model goes with it.">
        <button className="btn" onClick={() => window.eaon.sys.reveal(dir)} disabled={!dir}>
          <FolderOpen size={12} />
          Show
        </button>
      </Row>
    </>
  )
}
