import { useEffect, useState } from 'react'
import {
  Bot,
  Compass,
  Gauge,
  ArrowLeft,
  Code2,
  ExternalLink,
  GitBranch,
  Globe,
  LifeBuoy,
  Info,
  Keyboard,
  Mic,
  Minus,
  Palette,
  Plug,
  Plus,
  Scale,
  Search,
  Server,
  Sparkles,
  Tag,
  Terminal,
  UserRound,
  Volume2,
  X
} from 'lucide-react'
import { ACCENT_OVERRIDES, THEMES } from '@shared/themes'
import { SEARCH_ENGINES, engineById } from '@shared/browser'
import { useStore } from '../store/useStore'
import { IS_MAC } from '../lib/util'
import { SUDOERS, isSudo, useKeyLore, type Lore } from '../lib/eggs'

/** Read off the global rather than imported across the preload boundary. */
type SysInfo = Awaited<ReturnType<typeof window.eaon.sys.info>>
import { ThemeCard } from './ThemeCard'
import { VoicePanel } from './VoicePanel'
import { SpeechPanel } from './SpeechPanel'
import { UpdateSetting } from './UpdateSetting'
import { AccountsPanel } from './AccountsPanel'
import { HostsPanel } from './HostsPanel'
import { CodexAccountsPanel } from './CodexAccountsPanel'
import { IntegrationsPanel } from './IntegrationsPanel'
import { UsageSettings } from './UsageSettings'

type SectionId =
  | 'appearance'
  | 'terminal'
  | 'browser'
  | 'agents'
  | 'accounts'
  | 'integrations'
  | 'hosts'
  | 'usage'
  | 'voice'
  | 'speech'
  | 'shortcuts'
  | 'about'

interface Section {
  id: SectionId
  label: string
  icon: typeof Palette
  /** The one line under the page title. */
  blurb: string
  /**
   * What this page actually contains, for the search field.
   *
   * Matching page *names* would be a search that only finds what you could
   * already see in the list beside it. Typing "haptic" should land on the
   * control, not on a page that happens to be spelled similarly.
   */
  keywords: string[]
}

const SECTIONS: Section[] = [
  {
    id: 'accounts',
    label: 'Accounts',
    icon: UserRound,
    blurb: 'The accounts your panes run as.',
    keywords: ['account', 'sign in', 'login', 'claude', 'codex', 'max', 'plan', 'switch', 'email']
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Palette,
    blurb: 'Every surface, accent and terminal colour comes from the theme. Pick one and the whole window follows.',
    keywords: ['theme', 'colour', 'color', 'dark', 'light', 'accent', 'font', 'tabs', 'motion', 'contrast']
  },
  {
    id: 'usage',
    label: 'Plan usage',
    icon: Gauge,
    blurb: 'What your agents have spent, read from the transcripts they already write.',
    keywords: ['usage', 'tokens', 'cost', 'limit', 'quota', 'week', 'session', 'anthropic', 'percentage']
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: Bot,
    blurb: "Eaon ADE starts a shell and types the agent's command into it. Nothing is wrapped or intercepted.",
    keywords: ['agent', 'claude', 'codex', 'gemini', 'aider', 'opencode', 'copilot', 'grok', 'kimi', 'mistral', 'default', 'bell', 'permission']
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: Terminal,
    blurb: 'These apply to every open pane straight away — no restart, no reconnect.',
    keywords: ['terminal', 'font', 'size', 'line height', 'cursor', 'blink', 'scrollback', 'shell', 'zsh', 'bash']
  },
  {
    id: 'browser',
    label: 'Browser',
    icon: Compass,
    blurb: 'A browser tab is an ordinary browser pointed at what you are building. The address bar takes a bare port — type 5173 and it goes there.',
    keywords: ['browser', 'preview', 'url', 'address', 'search engine', 'zoom', 'home', 'localhost', 'port']
  },
  {
    id: 'voice',
    label: 'Voice',
    icon: Mic,
    blurb: 'Dictation runs on this machine. Your voice never leaves the computer.',
    keywords: ['voice', 'dictation', 'speech', 'whisper', 'model', 'microphone', 'hold to talk', 'language']
  },
  {
    id: 'speech',
    label: 'Spoken alerts',
    icon: Volume2,
    blurb: 'An agent that has stopped working can say so, which is useful when eight of them are running.',
    keywords: ['spoken', 'alerts', 'voice', 'announce', 'finished', 'say', 'speed', 'volume', 'notification']
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: Keyboard,
    blurb: 'Inside a pane the clipboard keys belong to the terminal. Everything else below belongs to Eaon ADE.',
    keywords: ['shortcut', 'keyboard', 'key', 'chord', 'command', 'palette', 'hotkey']
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: Plug,
    blurb: 'Panes inherit these, so an agent can push a branch or read an issue without being handed a token.',
    keywords: ['integration', 'github', 'gitlab', 'bitbucket', 'jira', 'linear', 'azure', 'token', 'credential']
  },
  {
    id: 'hosts',
    label: 'Remote hosts',
    icon: Server,
    blurb: 'Read from your own ~/.ssh/config every time, never copied here.',
    keywords: ['remote', 'host', 'ssh', 'server', 'config', 'proxyjump', 'key', 'machine']
  },
  {
    id: 'about',
    label: 'About',
    icon: Info,
    blurb: 'Everything runs on this machine — no account, no telemetry, no update pings.',
    keywords: ['about', 'version', 'build', 'update', 'reset', 'licence', 'license', 'github', 'source']
  }
]

/**
 * The project's own links, for the About page's footer.
 *
 * Every one resolves. The design this follows also carries Discord, Twitter,
 * terms, security and privacy; this project has none of those, and a footer
 * that offers a link to nowhere is worse than one that stays quiet about it.
 * They belong here the day the pages do.
 */
const ABOUT_LINKS: { label: string; href: string; icon: typeof Palette }[] = [
  { label: 'github', href: 'https://github.com/sanscreates/Eaon-ADE', icon: Code2 },
  { label: 'issues', href: 'https://github.com/sanscreates/Eaon-ADE/issues', icon: LifeBuoy },
  { label: 'releases', href: 'https://github.com/sanscreates/Eaon-ADE/releases', icon: Tag },
  { label: 'licence', href: 'https://github.com/sanscreates/Eaon-ADE/blob/main/LICENSE', icon: Scale },
  { label: 'eaon.dev', href: 'https://eaon.dev', icon: Globe }
]

/** The blank-space-separated blocks of the sidebar, in order. */
const GROUPS: { title: string; items: SectionId[] }[] = [
  { title: 'Personal', items: ['accounts', 'appearance', 'usage'] },
  { title: 'Editor & workflow', items: ['agents', 'terminal', 'browser', 'voice', 'speech', 'shortcuts'] },
  { title: 'Connections', items: ['integrations', 'hosts'] },
  { title: 'System', items: ['about'] }
]

/**
 * True when the field's text matches this page or anything on it.
 *
 * Prefixes of whole words, so "short" finds Shortcuts but "cut" does not —
 * the same shape of match a native settings field makes.
 */
function matches(section: Section, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  if (section.label.toLowerCase().includes(needle)) return true
  return section.keywords.some((term) =>
    term.split(' ').some((word) => word.startsWith(needle)) || term.startsWith(needle)
  )
}

/*
 * Two tables rather than one with substitutions, because the keymaps genuinely
 * differ. On Windows the shell keeps every bare Control chord, so the app sits
 * on Ctrl+Shift — and Ctrl+C has to be explained rather than silently changed.
 */
const MAC_SHORTCUTS: { keys: string; what: string }[] = [
  { keys: '⌘K', what: 'Commands' },
  { keys: '⌘T', what: 'New workspace' },
  { keys: '⌘D', what: 'Add a pane' },
  { keys: '⌘W', what: 'Close the focused pane' },
  { keys: '⌘E', what: 'Fill the grid with the focused pane' },
  { keys: '⌘1', what: 'Jump to a pane (through ⌘9)' },
  { keys: '⌘J', what: 'Conductor' },
  { keys: '⌘B', what: 'Workspaces sidebar' },
  { keys: '⌘⇧B', what: 'Side panel' },
  { keys: '⌘/', what: 'Resume a session' },
  { keys: 'Hold Right ⌘', what: 'Dictate while held' },
  { keys: '⌘⇧D', what: 'Dictate, start and stop by hand' },
  { keys: 'Esc', what: 'Discard what you are dictating' },
  { keys: '⌘,', what: 'Settings' },
  { keys: '⌘C / ⌘V', what: 'Copy and paste inside a terminal' },
  { keys: '⌘F', what: 'Find in the focused pane' },
  { keys: '⇧Return', what: 'New line in a pane, without sending' },
  { keys: '⌘← / ⌘→', what: 'Start and end of the line in a pane' },
  { keys: '⌘⌫ / ⌘⌦', what: 'Delete to the start / end of the line' },
  { keys: '⌥← / ⌥→', what: 'Move a word at a time in a pane' },
  { keys: '⌥⌫ / ⌥⌦', what: 'Delete a word behind / ahead' },
  { keys: '⌘= / ⌘- / ⌘0', what: 'Terminal font size' },
  { keys: 'Ctrl + anything', what: 'Always goes to the shell, never to Eaon ADE' }
]

const PC_SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'Ctrl+Shift+K', what: 'Commands' },
  { keys: 'Ctrl+Shift+T', what: 'New workspace' },
  { keys: 'Ctrl+Shift+D', what: 'Add a pane' },
  { keys: 'Ctrl+Shift+W', what: 'Close the focused pane' },
  { keys: 'Ctrl+Shift+E', what: 'Fill the grid with the focused pane' },
  { keys: 'Ctrl+Shift+1', what: 'Jump to a pane (through Ctrl+Shift+9)' },
  { keys: 'Ctrl+Shift+J', what: 'Conductor' },
  { keys: 'Ctrl+Shift+B', what: 'Workspaces sidebar' },
  { keys: 'Ctrl+Shift+O', what: 'Side panel' },
  { keys: 'Ctrl+Shift+/', what: 'Resume a session' },
  { keys: 'Hold Right Ctrl', what: 'Dictate while held' },
  { keys: 'Ctrl+Shift+M', what: 'Dictate, start and stop by hand' },
  { keys: 'Esc', what: 'Discard what you are dictating' },
  { keys: 'Ctrl+Shift+,', what: 'Settings' },
  { keys: 'Ctrl+Shift+C / Ctrl+Shift+V', what: 'Copy and paste inside a terminal' },
  { keys: 'Ctrl+C', what: 'Interrupt — or copy, when text is selected' },
  { keys: '⇧Return', what: 'New line in a pane, without sending' },
  { keys: 'Ctrl+= / Ctrl+- / Ctrl+0', what: 'Terminal font size' },
  { keys: 'Ctrl+A, Ctrl+E, Ctrl+W…', what: 'Left to the shell, as on any terminal' }
]

const SHORTCUTS = IS_MAC ? MAC_SHORTCUTS : PC_SHORTCUTS

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

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const agents = useStore((s) => s.agents)
  const sys = useStore((s) => s.appVersion)

  const [section, setSection] = useState<SectionId>('accounts')
  const [query, setQuery] = useState('')
  const [statePath, setStatePath] = useState('')

  /** xyzzy: 'said' while the game's reply is on screen, 'shown' once it isn't. */
  const [xyzzy, setXyzzy] = useState<'no' | 'said' | 'shown'>('no')
  const [machine, setMachine] = useState<SysInfo | null>(null)
  /** The theme the konami code just turned up, for the one-off note. */
  const [unlocked, setUnlocked] = useState<string | null>(null)
  /** Taps on the version chip. Seven earns a hint. */
  const [taps, setTaps] = useState(0)

  // Guarded: this comes off disk, and a hand-edited state.json is allowed to
  // be wrong without taking Appearance down with it.
  const found = Array.isArray(settings.foundThemes) ? settings.foundThemes : []

  useEffect(() => {
    if (!open) return
    void window.eaon.state.path().then(setStatePath)
    void window.eaon.sys.info().then(setMachine)
  }, [open])

  // Whatever was found last time stays found; the state is reset per visit.
  useEffect(() => {
    if (!open) {
      setXyzzy('no')
      setUnlocked(null)
      setTaps(0)
    }
  }, [open])

  const onLore = (lore: Lore): void => {
    if (lore === 'quit') {
      setOpen(false)
      return
    }
    if (lore === 'xyzzy') {
      // Adventure's reply first. The machine follows a beat later, which is
      // the joke: in the cave nothing happens, here something does.
      setSection('about')
      setXyzzy('said')
      window.setTimeout(() => setXyzzy('shown'), 1100)
      return
    }
    // konami. Idempotent: finding it twice is not an error, it is just Tuesday.
    const secret = THEMES.filter((t) => t.secret)
    const next = secret.find((t) => !found.includes(t.id)) ?? secret[0]
    if (!next) return
    setSection('appearance')
    setUnlocked(next.id)
    if (!found.includes(next.id)) update({ foundThemes: [...found, next.id] })
  }

  // Sequences are only watched while Settings is on screen.
  useKeyLore(open, onLore)

  // Escape leaves Settings, the same as the close button.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // A dictation session or an open menu gets first refusal on Escape.
      if (e.defaultPrevented) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  /*
   * A secret theme is listed once it has been found — and also whenever it is
   * the one in use, so that a profile copied to another machine cannot leave
   * someone staring at a palette they have no way to switch back to.
   */
  const visible = THEMES.filter(
    (t) => !t.secret || found.includes(t.id) || settings.themeId === t.id
  )
  const dark = visible.filter((t) => t.mode === 'dark')
  const light = visible.filter((t) => t.mode === 'light')

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]

  return (
    <div className="settings-surface" role="region" aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <button className="settings-back" onClick={() => setOpen(false)}>
          <ArrowLeft size={15} />
          Back
        </button>
        <h2 className="settings-nav-title">Settings</h2>

        <span className="settings-search">
          <Search size={13} />
          <input
            value={query}
            placeholder="Search settings…"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search settings"
          />
          {query && (
            <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => setQuery('')} aria-label="Clear">
              <X size={11} />
            </button>
          )}
        </span>

        <div className="settings-groups">
          {GROUPS.map((group) => {
            const items = group.items
              .map((id) => SECTIONS.find((sec) => sec.id === id))
              .filter((sec): sec is Section => Boolean(sec) && matches(sec as Section, query))
            // A group with nothing left in it is a heading over blank space.
            if (items.length === 0) return null
            return (
              <div className="settings-group" key={group.title}>
                <p className="eyebrow settings-group-title">{group.title}</p>
                {items.map((sec) => {
                  const Icon = sec.icon
                  return (
                    <button
                      className="settings-nav-item"
                      key={sec.id}
                      data-on={section === sec.id}
                      onClick={() => setSection(sec.id)}
                    >
                      <Icon size={14} />
                      {sec.label}
                    </button>
                  )
                })}
              </div>
            )
          })}
          {SECTIONS.every((sec) => !matches(sec, query)) &&
            (isSudo(query) ? (
              // No settings page is named sudo, so this lands in the
              // nothing-matched slot rather than needing a branch of its own.
              <p className="settings-none mono egg-sudo">
                <b>{machine?.home.split('/').filter(Boolean).pop() ?? 'you'}</b> {SUDOERS}
              </p>
            ) : (
              <p className="settings-none">Nothing matching “{query}”.</p>
            ))}
        </div>

        <button
          className="settings-doc"
          onClick={() => window.eaon.sys.openExternal('https://github.com/sanscreates/Eaon-ADE#readme')}
        >
          <ExternalLink size={14} />
          Documentation
        </button>
      </nav>

      <div className="settings-main">
        <header className="settings-head">
          <span className="settings-heading">
            <h1 className="settings-title">{current.label}</h1>
            <p className="settings-blurb">{current.blurb}</p>
          </span>
          <span className="spacer" />
          <button
            className="icon-btn"
            onClick={() => setOpen(false)}
            aria-label="Close settings"
            title="Close settings (Esc)"
          >
            <X size={16} />
          </button>
        </header>

        <div className="settings-pane">
            {section === 'appearance' && (
              <>

                <div className="section-head">
                  <span className="eyebrow">Theme</span>
                  <span className="section-note">{visible.length} available</span>
                </div>

                {/*
                  Shown the once, straight after the konami code. It names the
                  theme rather than being coy about it — the find is the reward,
                  and a note that made you hunt the grid for what changed would
                  be spending the user's time to prolong a joke.
                */}
                {unlocked && (
                  <p className="egg-note" role="status">
                    <Sparkles size={13} />
                    <span>
                      <b>{THEMES.find((t) => t.id === unlocked)?.name}</b> unlocked. It stays in
                      this list from now on.
                    </span>
                    <button
                      className="btn"
                      onClick={() => {
                        update({ themeId: unlocked })
                        setUnlocked(null)
                      }}
                    >
                      Use it
                    </button>
                  </p>
                )}

                <p className="eyebrow" style={{ margin: '4px 0 8px' }}>
                  Dark
                </p>
                <div className="theme-grid">
                  {dark.map((t) => (
                    <ThemeCard
                      key={t.id}
                      theme={t}
                      active={settings.themeId === t.id}
                      onPick={() => update({ themeId: t.id })}
                    />
                  ))}
                </div>

                <p className="eyebrow" style={{ margin: '22px 0 8px' }}>
                  Light
                </p>
                <div className="theme-grid">
                  {light.map((t) => (
                    <ThemeCard
                      key={t.id}
                      theme={t}
                      active={settings.themeId === t.id}
                      onPick={() => update({ themeId: t.id })}
                    />
                  ))}
                </div>

                <div style={{ marginTop: 24 }}>
                  <Row
                    name="Accent"
                    desc="Override the theme's accent. Status colours never change — running stays one colour, waiting-on-you stays another."
                  >
                    <div className="swatches">
                      <button
                        className="swatch swatch-auto"
                        data-on={settings.accentOverride === null}
                        onClick={() => update({ accentOverride: null })}
                        aria-label="Follow the theme"
                        title="Follow the theme"
                      />
                      {ACCENT_OVERRIDES.map((a) => (
                        <button
                          className="swatch"
                          key={a.id}
                          data-on={settings.accentOverride === a.id}
                          style={{ background: a.hex }}
                          onClick={() => update({ accentOverride: a.id })}
                          aria-label={`Accent ${a.label}`}
                          title={a.label}
                        />
                      ))}
                    </div>
                  </Row>

                  <Row
                    name="Workspace tabs"
                    desc="A tab per workspace across the top of the stage, beside the rail."
                  >
                    <Toggle
                      on={settings.showWorkspaceTabs}
                      onChange={(v) => update({ showWorkspaceTabs: v })}
                      label="Workspace tabs"
                    />
                  </Row>

                  <Row name="Reduce motion" desc="Turns off pulsing dots and panel animations.">
                    <Toggle
                      on={settings.reduceMotion}
                      onChange={(v) => update({ reduceMotion: v })}
                      label="Reduce motion"
                    />
                  </Row>
                </div>
              </>
            )}

            {section === 'terminal' && (
              <>

                <Row name="Font size" desc="Smaller text fits more agents on screen.">
                  <div className="stepper-num">
                    <button
                      className="icon-btn"
                      onClick={() => update({ fontSize: Math.max(8, settings.fontSize - 1) })}
                      aria-label="Smaller"
                    >
                      <Minus size={12} />
                    </button>
                    <span>{settings.fontSize}px</span>
                    <button
                      className="icon-btn"
                      onClick={() => update({ fontSize: Math.min(22, settings.fontSize + 1) })}
                      aria-label="Larger"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </Row>

                <Row name="Line height" desc="Breathing room between rows.">
                  <select
                    className="select"
                    value={settings.lineHeight}
                    onChange={(e) => update({ lineHeight: Number(e.target.value) })}
                  >
                    {[1, 1.15, 1.35, 1.5, 1.7].map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Row>

                <Row name="Font" desc="Any monospace family installed on this machine.">
                  <input
                    className="select mono"
                    style={{ width: 230 }}
                    value={settings.fontFamily}
                    spellCheck={false}
                    onChange={(e) => update({ fontFamily: e.target.value })}
                    aria-label="Terminal font"
                  />
                </Row>

                <Row name="Cursor" desc="Shape and blink.">
                  <select
                    className="select"
                    value={settings.cursorStyle}
                    onChange={(e) =>
                      update({ cursorStyle: e.target.value as 'block' | 'bar' | 'underline' })
                    }
                  >
                    <option value="bar">Bar</option>
                    <option value="block">Block</option>
                    <option value="underline">Underline</option>
                  </select>
                  <Toggle
                    on={settings.cursorBlink}
                    onChange={(v) => update({ cursorBlink: v })}
                    label="Cursor blink"
                  />
                </Row>

                <Row name="Scrollback" desc="Lines kept per pane. More lines use more memory.">
                  <select
                    className="select"
                    value={settings.scrollback}
                    onChange={(e) => update({ scrollback: Number(e.target.value) })}
                  >
                    {[2000, 5000, 8000, 20000, 50000].map((v) => (
                      <option key={v} value={v}>
                        {v.toLocaleString()}
                      </option>
                    ))}
                  </select>
                </Row>

                <Row name="Shell" desc="Leave blank to use your login shell.">
                  <input
                    className="select mono"
                    style={{ width: 180 }}
                    value={settings.shell}
                    placeholder="/bin/zsh"
                    spellCheck={false}
                    onChange={(e) => update({ shell: e.target.value })}
                    aria-label="Shell"
                  />
                </Row>
              </>
            )}

            {section === 'browser' && (
              <>

                <Row
                  name="Search engine"
                  desc="Used when the address bar is given words instead of an address. Nothing is sent anywhere until you press Return."
                >
                  <select
                    className="select"
                    value={settings.browserSearchEngine}
                    onChange={(e) => update({ browserSearchEngine: e.target.value })}
                  >
                    {SEARCH_ENGINES.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                </Row>
                <p className="setting-desc" style={{ margin: '-6px 0 4px' }}>
                  {engineById(settings.browserSearchEngine).note}
                </p>

                <Row
                  name="Home address"
                  desc="Where the panel opens. It follows you as you browse, so it is usually the last place you were."
                >
                  <input
                    className="select mono"
                    value={settings.browserHome}
                    spellCheck={false}
                    aria-label="Home address"
                    onChange={(e) => update({ browserHome: e.target.value })}
                  />
                </Row>

                <Row name="Page zoom" desc="Applies to every page in the panel. ⌘0 resets it.">
                  <div className="stepper-num">
                    <button
                      className="icon-btn"
                      onClick={() =>
                        update({
                          browserZoom: Math.max(0.5, Number((settings.browserZoom - 0.1).toFixed(2)))
                        })
                      }
                      aria-label="Smaller"
                    >
                      <Minus size={12} />
                    </button>
                    <span>{Math.round(settings.browserZoom * 100)}%</span>
                    <button
                      className="icon-btn"
                      onClick={() =>
                        update({
                          browserZoom: Math.min(2.5, Number((settings.browserZoom + 0.1).toFixed(2)))
                        })
                      }
                      aria-label="Larger"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </Row>
              </>
            )}

            {section === 'agents' && (
              <>

                <Row name="Default agent" desc="Pre-selected for new workspaces and new panes.">
                  <select
                    className="select"
                    value={settings.defaultAgentId}
                    onChange={(e) => update({ defaultAgentId: e.target.value })}
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id} disabled={a.available === false}>
                        {a.label}
                        {a.available === false ? ' (not installed)' : ''}
                      </option>
                    ))}
                  </select>
                </Row>

                <Row
                  name="Skip permission prompts"
                  desc="Claude Code starts with --dangerously-skip-permissions, so it acts without asking first. Applies to new panes and to sessions reopened on launch."
                >
                  <Toggle
                    on={settings.bypassPermissions}
                    onChange={(v) => update({ bypassPermissions: v })}
                    label="Skip permission prompts"
                  />
                </Row>

                <Row
                  name="Terminal bell marks a pane"
                  desc="Agents ring the bell when they need a decision. Turn this off to stop the highlight."
                >
                  <Toggle
                    on={settings.bellAttention}
                    onChange={(v) => update({ bellAttention: v })}
                    label="Bell marks a pane"
                  />
                </Row>

                <Row
                  name="Ask before closing a workspace"
                  desc="Closing ends every session inside it."
                >
                  <Toggle
                    on={settings.confirmClose}
                    onChange={(v) => update({ confirmClose: v })}
                    label="Ask before closing"
                  />
                </Row>

                <div className="section-head" style={{ marginTop: 22 }}>
                  <span className="eyebrow">Found on this machine</span>
                </div>
                <div style={{ display: 'grid', gap: 7 }}>
                  {agents
                    .filter((a) => a.bin)
                    .map((a) => (
                      <div
                        key={a.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12 }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            background: a.available ? 'var(--live)' : 'var(--text-dim)'
                          }}
                        />
                        <span
                          style={{ color: a.available ? 'var(--text-mid)' : 'var(--text-dim)' }}
                        >
                          {a.label}
                        </span>
                        <span className="chip mono" style={{ marginLeft: 'auto' }}>
                          {a.available ? a.bin : 'not on PATH'}
                        </span>
                      </div>
                    ))}
                </div>
              </>
            )}

            {section === 'voice' && <VoicePanel />}

            {section === 'speech' && <SpeechPanel />}

            {section === 'accounts' && (
              <>
                <AccountsPanel />
                <CodexAccountsPanel />
              </>
            )}

            {section === 'integrations' && <IntegrationsPanel />}

            {section === 'hosts' && <HostsPanel />}

            {section === 'usage' && <UsageSettings />}

            {section === 'shortcuts' && (
              <>
                <div className="shortcut-list">
                  {SHORTCUTS.map((s) => (
                    <div className="shortcut-row" key={s.keys}>
                      <span className="kbd">{s.keys}</span>
                      <span>{s.what}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {section === 'about' && (
              <>

                <Row
                  name="Updates"
                  desc="Checked on launch and every few hours. New versions download in the background and install when you restart."
                >
                  <UpdateSetting />
                </Row>

                <Row name="Where your settings live" desc="Workspaces, presets, board and vault.">
                  <span className="chip mono" title={statePath} style={{ maxWidth: 260 }}>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        direction: 'rtl'
                      }}
                    >
                      {/* rtl puts the ellipsis at the front, where a long path
                          wants it — but it also drags the leading "/" round to
                          the end, because a neutral at a paragraph edge takes
                          the paragraph's direction. The LRM anchors it. */}
                      {'‎' + statePath}
                    </span>
                  </span>
                </Row>

                <Row
                  name="Start over"
                  desc="Deletes every workspace, preset, board card and vault note."
                >
                  <button
                    className="btn"
                    onClick={async () => {
                      if (!window.confirm('Reset every workspace, preset and setting?')) return
                      await window.eaon.state.reset()
                      window.location.reload()
                    }}
                  >
                    Reset everything
                  </button>
                </Row>

                {/*
                  xyzzy. Adventure answers "Nothing happens." when you say the
                  magic word in the wrong room, which is the whole joke — here
                  it answers the same way and then the machine prints anyway.

                  Everything below is already on this page or one IPC away. The
                  egg is the framing, not privileged information.
                */}
                {xyzzy !== 'no' && (
                  <pre className="egg-machine mono" data-open={xyzzy === 'shown'}>
                    <span className="egg-said">&gt; xyzzy{'\n'}Nothing happens.</span>
                    {xyzzy === 'shown' && machine && (
                      <span className="egg-rows">
                        {'\n'}
                        {[
                          ['eaon ade', `v${sys}`],
                          ['electron', machine.electron],
                          ['chrome', /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '—'],
                          ['node', machine.node],
                          ['platform', `${machine.platform} · ${navigator.hardwareConcurrency} cores`],
                          ['shell', machine.shell || 'login default'],
                          ['themes', `${THEMES.length} (${found.length} found)`],
                          ['agents', `${agents.length} configured`]
                        ]
                          .map(([k, v]) => `${k.padEnd(9)} ${v}`)
                          .join('\n')}
                        {'\n\n'}Well. Something happened.
                      </span>
                    )}
                  </pre>
                )}

                <p className="setting-desc" style={{ marginTop: 20, lineHeight: 1.7 }}>
                  Dracula, Gruvbox, Nord, Tokyo Night, Catppuccin, One Dark and Rosé Pine palettes
                  are reproduced from their MIT-licensed projects, with thanks to their
                  authors.
                </p>

                {/*
                  Where the project lives, in the shape a project footer takes:
                  links on the left, what you are running on the right.

                  Only links that exist. A footer that offers Discord and
                  Twitter and lands you on a 404 is worse than one that does
                  not offer them — every row below is a real destination for
                  this repository.
                */}
                <div className="about-foot">
                  <span className="about-links">
                    {ABOUT_LINKS.map((link) => {
                      const Icon = link.icon
                      return (
                        <button
                          className="about-link"
                          key={link.label}
                          onClick={() => window.eaon.sys.openExternal(link.href)}
                          title={link.href}
                        >
                          <Icon size={13} />
                          {link.label}
                        </button>
                      )
                    })}
                  </span>
                  <span className="about-meta">
                    <span className="about-chip">
                      <Palette size={12} />
                      {THEMES.find((t) => t.id === settings.themeId)?.name ?? 'Custom'}
                    </span>
                    {/*
                      The way in. Nothing else on this page advertises that
                      there is anything to find, so the version chip does the
                      job the About box has done since Android put a jellybean
                      behind one — seven taps, and a hint rather than a prize.
                    */}
                    <button
                      className="about-chip mono"
                      onClick={() => setTaps((n) => n + 1)}
                      title={
                        taps >= 3 && taps < 7
                          ? `${7 - taps} more`
                          : 'The version you are running'
                      }
                    >
                      <GitBranch size={12} />v{sys}
                    </button>
                  </span>
                </div>

                {taps >= 7 && (
                  <p className="egg-hint" role="status">
                    Somewhere in here: a magic word from 1976, a cheat code from 1988, and a way
                    out for vi hands.
                  </p>
                )}
              </>
            )}
        </div>
      </div>
    </div>
  )
}
