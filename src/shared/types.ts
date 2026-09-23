/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. Keep this file free of runtime imports so both sides can use it.
 */

import { DEFAULT_THEME_ID } from './themes'
import { DEFAULT_SEARCH_ENGINE } from './browser'
import type { Trial } from './worktrees'
import type { SshHost } from './ssh'
import type { Automation } from './automations'

export type PaneStatus = 'live' | 'idle' | 'attention' | 'exited'

export type SurfaceId = 'grid' | 'swarm' | 'board' | 'vault' | 'brain'

export interface AgentDef {
  id: string
  label: string
  /** Binary we look for on PATH. */
  bin: string
  /** Extra args appended after the binary. */
  args: string[]
  /** Short line shown in the picker. */
  blurb: string
  /** Whether the binary was found on this machine. Filled in at runtime. */
  available?: boolean
}

/**
 * What a grid cell holds.
 *
 * Absent reads as `'terminal'`, matching every other "kind" in this file —
 * so a workspace persisted before previews and diff panes existed opens
 * exactly as it always did, no migration needed.
 */
export type PaneKind = 'terminal' | 'preview' | 'diff'

export interface PaneSpec {
  id: string
  /** Absent means 'terminal'. Use paneKind(pane) rather than reading this raw. */
  kind?: PaneKind
  /** Stable short handle: "Tate", "Ava". Used for addressing in broadcasts. */
  name: string
  /** Title reported by the program via the OSC title escape, if any. */
  title: string | null
  cwd: string
  agentId: string
  /** Full command line that was launched, or null for a bare shell. */
  command: string | null
  status: PaneStatus
  /**
   * Whether something is running in this pane right now.
   *
   * Not the same as status === 'live', which only means bytes arrived — and
   * bytes arrive on every keystroke you type into an agent's prompt. Derived
   * from timing in terminals.ts; transient, like status.
   */
  working: boolean
  branch: string | null
  /** Context percentage parsed out of the agent's own status line. */
  contextPct: number | null
  /**
   * The conversation this pane owns.
   *
   * Chosen by us before the agent starts rather than read back afterwards, so
   * a pane and its conversation are bound together from the first moment and
   * stay bound across a restart. Null for a bare shell, or for a pane restored
   * from a command that already names its own session.
   */
  sessionId: string | null
  createdAt: number
  /**
   * When this pane last started or stopped doing something.
   *
   * Stamped on the transition rather than on every byte, so it is cheap and
   * so the gap since it means something exact: for an idle pane it is how
   * long it has been idle, which is what the rail's roster reports. Absent
   * until the pane first moves, and on anything restored from a state file
   * written before this field — read it through `sinceOf()`, which falls
   * back to `createdAt`.
   */
  lastActiveAt?: number
  /** kind: 'preview' only — the file this pane shows. Ignored otherwise. */
  previewPath?: string | null
}

/** `pane.kind`, defaulted — the one place that should ever read the raw field. */
export function paneKind(pane: PaneSpec): PaneKind {
  return pane.kind ?? 'terminal'
}

/**
 * What a workspace holds.
 *
 * Terminal workspaces own panes. The rest own a single surface and no shells —
 * they sit in the same rail so that opening the board is switching to something
 * rather than covering over what you were doing.
 */
export type WorkspaceKind = 'terminals' | 'board' | 'vault' | 'brain' | 'stats' | 'browser'

/**
 * `browser` is deliberately absent from `PANEL_KINDS` below. The panel kinds
 * are the one-per-app surfaces the rail offers as chips; a browser is not one
 * of those — you open as many as you like, as tabs of a project, from the
 * tab strip's own menu.
 */

/** Kinds that hold a surface instead of shells. */
export const PANEL_KINDS = ['board', 'vault', 'brain', 'stats'] as const

export const PANEL_LABEL: Record<(typeof PANEL_KINDS)[number], string> = {
  board: 'Board',
  vault: 'Vault',
  brain: 'Brain',
  stats: 'Stats'
}

/*
 * Asked of `PANEL_KINDS`, not answered as "anything that is not terminals".
 *
 * The exclusion form was true right up until `browser` was added, and then it
 * was worse than merely wrong: this is a type predicate, so it narrowed the
 * caller to board|vault|brain|stats while letting a browser through at run
 * time. Nothing downstream would have to be careless to break — it would be
 * doing what the signature promised.
 */
export function isPanelKind(kind: WorkspaceKind): kind is (typeof PANEL_KINDS)[number] {
  return (PANEL_KINDS as readonly string[]).includes(kind)
}

/**
 * A group in the rail.
 *
 * Holds nothing itself — a workspace points at the folder it is filed under —
 * so deleting one can never take a session with it. That is the whole reason it
 * is modelled this way round rather than as a folder owning a list of ids: a
 * workspace has exactly one home, and it cannot go missing by being in a list
 * that got dropped.
 */
export interface WorkspaceFolder {
  id: string
  name: string
  /** Folded shut in the rail. Remembered across restarts, like everything else. */
  collapsed: boolean
  createdAt: number
}

export interface Workspace {
  id: string
  /** Absent on anything saved before workspaces had kinds; read as 'terminals'. */
  kind: WorkspaceKind
  name: string
  cwd: string
  hue: string
  /** Number of panes the workspace was opened with. */
  layout: number
  panes: PaneSpec[]
  /**
   * Where the dividers have been dragged to. Absent until one is moved, and on
   * anything saved before they could be.
   */
  grid: GridTracks | null
  activePaneId: string | null
  zoomedPaneId: string | null
  /**
   * The folder this is filed under, or null for the top level. Absent on
   * anything saved before folders existed, which reads the same as null.
   */
  folderId: string | null
  /**
   * The project this workspace is a tab of — the git repository root its `cwd`
   * belongs to, shared by every tab of that project including the worktree
   * ones, whose own `cwd` is a checkout somewhere under app data and so says
   * nothing about where they came from.
   *
   * Absent on anything saved before tabs were scoped to projects; read
   * `projectOf()` rather than this field directly, which falls back to `cwd`
   * so an old workspace is simply a project of one.
   */
  projectRoot?: string | null
  createdAt: number
  /**
   * The remote box every pane in this workspace runs on, or null/absent for a
   * normal local workspace. A workspace either has a host or it doesn't —
   * panes are not mixed local/remote within one, which is what lets every
   * other panel (terminals, git, worktrees) stay ignorant of the distinction
   * and just call the same store actions.
   *
   * Embedded rather than looked up by id: there is no separate host registry
   * to keep in sync. A config-sourced host connects by alias, so editing
   * `~/.ssh/config` takes effect on the next connection regardless of what
   * was parsed out of it when the workspace was created; a manually-entered
   * host's fields are fixed for that workspace's lifetime — changing them
   * means creating a new remote workspace, which is a real v1 limitation
   * rather than a half-built settings-sync path.
   */
  host?: SshHost | null
}

export interface Preset {
  id: string
  name: string
  layout: number
  agentId: string
  /** Optional folder this preset always opens in. */
  cwd?: string
  /** Optional prompt broadcast to every pane once the agents are up. */
  prompt?: string
}

export interface RecentFolder {
  path: string
  name: string
  lastOpened: number
  sessions: number
}

export interface Settings {
  themeId: string
  /** Null follows the theme's own accent; otherwise an ACCENT_OVERRIDES id. */
  accentOverride: string | null
  fontFamily: string
  fontSize: number
  lineHeight: number
  shell: string
  defaultAgentId: string
  /**
   * Start agents with their own permission prompting turned off.
   *
   * Applies to every launch, not just new panes — see BYPASS_FLAGS.
   */
  bypassPermissions: boolean
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  scrollback: number
  confirmClose: boolean
  reduceMotion: boolean
  bellAttention: boolean
  /** A tab per workspace across the top of the stage, beside the rail. */
  showWorkspaceTabs: boolean
  /**
   * Ids of themes marked `secret` that this install has turned up.
   *
   * A list rather than a flag so finding one never reveals the rest, and so a
   * theme that is already in use cannot vanish from Appearance when a later
   * version adds another one.
   */
  foundThemes: string[]

  // ---- voice dictation ---------------------------------------------------
  /** Catalogue id of the downloaded speech model to use. Empty means none yet. */
  voiceModelId: string
  /** Microphone deviceId, or empty for the system default. */
  voiceMicId: string
  /** 'auto' or an ISO code. Ignored by English-only models, which reject it. */
  voiceLanguage: string
  /** Stop listening after this much silence. 0 keeps the mic open until you stop it. */
  voiceSilenceMs: number
  /**
   * KeyboardEvent.code of the key you hold to talk, or '' for no hold key.
   *
   * Not Fn: macOS never delivers the Fn/globe key to an application's key
   * handling at all, so it cannot be observed without a native input monitor
   * and the permission that comes with it.
   */
  voiceHoldKey: string

  // ---- spoken alerts -----------------------------------------------------
  /**
   * Say "<pane> has finished" out loud when an agent stops working.
   *
   * Off until you ask for it. A tool that starts talking to you the first time
   * you open it has made a decision that was yours to make.
   */
  speakOnFinish: boolean
  /** System voice name, or '' to use the best one installed. */
  speakVoice: string
  /** Words per minute handed to the synthesiser. */
  speakRate: number
  /** 0 to 1. */
  speakVolume: number
  /** Only speak when the pane that finished is not the one you are watching. */
  speakOnlyWhenAway: boolean

  // ---- preview browser ---------------------------------------------------
  /** Address the preview panel opens at, and the last one you visited. */
  browserHome: string
  /** SEARCH_ENGINES id used when the address bar is given words, not an address. */
  browserSearchEngine: string
  /** Page zoom, as a multiplier. Kept so it survives a restart, as a browser's does. */
  browserZoom: number

  // ---- plan usage --------------------------------------------------------
  /**
   * Ask Anthropic for the real percentages instead of reading the transcripts.
   *
   * Off by default, and deliberately: turning it on lets the app read the OAuth
   * token out of Claude Code's credentials and make a request as you. The local
   * reading needs neither and is what runs until you say otherwise.
   */
  usageFromAnthropic: boolean
  /** Billed tokens the 5-hour window is measured against. 0 uses the plan default. */
  usageSessionLimit: number
  /** Billed tokens the 7-day window is measured against. 0 uses the plan default. */
  usageWeekLimit: number

  // ---- remote targets ----------------------------------------------------
  /**
   * Hosts typed in by hand, kept so they are offered again.
   *
   * Entries in `~/.ssh/config` are not copied here — that file is the user's
   * own and is read fresh every time, so a change made there shows up without
   * anything needing to be re-saved. This is only for boxes that are not in
   * it. Connection details, never a credential: see the note on SshHost.
   */
  sshHosts: SshHost[]
}

export interface BoardCard {
  id: string
  title: string
  notes: string
  column: 'queued' | 'running' | 'review' | 'done'
  assignedPaneName: string | null
  createdAt: number
}

export interface VaultNote {
  id: string
  title: string
  body: string
  updatedAt: number
}

export interface PersistedState {
  version: number
  workspaces: Workspace[]
  /** Rail groups. Absent on anything saved before folders existed. */
  folders: WorkspaceFolder[]
  activeWorkspaceId: string | null
  presets: Preset[]
  recents: RecentFolder[]
  settings: Settings
  board: BoardCard[]
  vault: VaultNote[]
  dismissedResume: string[]
  /**
   * Running and finished trials. Absent on anything saved before isolated
   * worktrees existed, which reads the same as none.
   */
  trials?: Trial[]
  /** Saved prompts with triggers. Absent on anything saved before them. */
  automations?: Automation[]
}

export interface ResumableSession {
  id: string
  tool: string
  cwd: string
  label: string
  command: string
  updatedAt: number
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

export interface GitFile {
  path: string
  index: string
  work: string
  staged: boolean
}

export interface GitStatus {
  repo: boolean
  branch: string | null
  ahead: number
  behind: number
  files: GitFile[]
}

export interface SpawnRequest {
  paneId: string
  /** Local path, or the remote path when `host` is set. */
  cwd: string
  cols: number
  rows: number
  shell?: string
  /** Command typed into the fresh shell, e.g. "claude". */
  command?: string | null
  /** Which agent this is, so the session flags can be chosen for it. */
  agentId?: string
  /** Conversation to pin or reopen. The main process decides which. */
  sessionId?: string | null
  /**
   * Set when this pane belongs to a workspace connected to a remote box. The
   * pane runs the real `ssh` binary instead of a local shell (src/main/ssh.ts)
   * — that binary is the only thing that ever touches a key or a passphrase.
   */
  host?: SshHost | null
}

/**
 * Agents that let a conversation be named up front.
 *
 * `pin` starts a new conversation under an id we chose; `resume` reopens it.
 * Naming it in advance is what makes reopening exact — the alternative is
 * guessing from timestamps, which falls apart the moment two panes share a
 * folder. Anything absent from here simply starts fresh, as it always did.
 */
export const SESSION_FLAGS: Record<string, { pin: string; resume: string }> = {
  claude: { pin: '--session-id', resume: '--resume' }
}

/** True when a pane running this agent should be given a conversation id. */
export function agentKeepsSessions(agentId: string): boolean {
  return agentId in SESSION_FLAGS
}

/**
 * The flag that stops an agent asking permission before each action.
 *
 * Only Claude Code is listed. The other agents spell this differently and each
 * turns off a slightly different thing, so a wrong guess here would either be
 * rejected on the command line or hand out more than was asked for — adding one
 * is a deliberate act, not a pattern to extend by analogy.
 */
export const BYPASS_FLAGS: Record<string, string> = {
  claude: '--dangerously-skip-permissions'
}

export const LAYOUTS = [1, 2, 4, 6, 8, 10, 12] as const

/** Column count for a given pane count. Rows fall out of it. */
/**
 * How the space is shared out between the panes.
 *
 * Fractions rather than pixels, so a workspace arranged on one screen still
 * looks like itself on another, and so a window resize divides what is there
 * instead of leaving a gap.
 *
 * One list per axis rather than one per pane. The grid's columns run the whole
 * height of the workspace, so widening a column widens every pane sitting in
 * it — that is what tiling means, and it is why panes can never overlap or be
 * left somewhere you cannot find them.
 */
export interface GridTracks {
  cols: number[]
  rows: number[]
}

/**
 * The tracks to lay a workspace out on, given how many panes it holds.
 *
 * Saved sizes are kept only while they still describe the shape they were saved
 * for. Close a pane out of a six-up and the grid becomes three columns where
 * there were four; sizes measured for the old shape would be read against the
 * new one and put the dividers in places nobody dragged them to. Anything that
 * no longer fits falls back to equal shares, which is the arrangement you would
 * have had before ever touching a divider.
 */
export function tracksFor(count: number, saved?: GridTracks | null): GridTracks {
  const cols = gridColumns(count)
  const rows = Math.max(1, Math.ceil(count / cols))
  const fit = (list: number[] | undefined, n: number): number[] =>
    list?.length === n && list.every((v) => Number.isFinite(v) && v > 0)
      ? list
      : Array.from({ length: n }, () => 1)
  return { cols: fit(saved?.cols, cols), rows: fit(saved?.rows, rows) }
}

export function gridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 2) return 2
  if (count <= 4) return 2
  if (count <= 6) return 3
  if (count <= 9) return 3
  return 4
}

export function gridShape(count: number): { cols: number; rows: number } {
  const cols = gridColumns(count)
  return { cols, rows: Math.ceil(count / cols) }
}

export const AGENTS: AgentDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    args: [],
    blurb: 'Anthropic’s terminal agent'
  },
  { id: 'codex', label: 'Codex', bin: 'codex', args: [], blurb: 'OpenAI’s terminal agent' },
  { id: 'gemini', label: 'Gemini CLI', bin: 'gemini', args: [], blurb: 'Google’s terminal agent' },
  { id: 'aider', label: 'Aider', bin: 'aider', args: [], blurb: 'Pair programmer in your repo' },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode', args: [], blurb: 'Open-source terminal agent' },
  { id: 'copilot', label: 'Copilot', bin: 'copilot', args: [], blurb: 'GitHub’s terminal agent' },
  { id: 'mistral', label: 'Mistral Vibe', bin: 'vibe', args: [], blurb: 'Mistral’s terminal agent' },
  { id: 'kimi', label: 'Kimi Code', bin: 'kimi', args: [], blurb: 'Moonshot’s terminal agent' },
  { id: 'grok', label: 'Grok', bin: 'grok', args: [], blurb: 'xAI’s terminal agent' },
  { id: 'shell', label: 'Plain shell', bin: '', args: [], blurb: 'No agent, just a terminal' }
]

/** Short handles assigned to panes so you can address them out loud. */
export const NAME_POOL = [
  'Ada','Bo','Cleo','Dex','Esme','Flint','Gus','Hazel','Iris','Jax','Kit','Lark',
  'Mica','Nia','Otto','Pia','Quill','Remy','Sage','Tate','Uma','Vero','Wade','Xan',
  'Yuri','Zev','Bram','Cove','Dune','Eero','Fen','Gale','Hollis','Ines','Juno','Knox',
  'Aster','Briar','Cyra','Dara','Elio','Faro','Grey','Halo','Ida','Jem','Kali','Leif',
  'Mabel','Neve','Orin','Pax','Quinn','Rhea','Silas','Tova','Ulric','Vale','Wren','Xara',
  'Yara','Zola','Arlo','Basil','Cass','Dax','Enzo','Fable','Gwen','Hale','Ivo','Joss',
  'Kiro','Lena','Mose','Nash','Olly','Pip','Ren','Skye','Talon','Uri','Vesper','Wick',
  'Xene','Yuno','Zane','Ash','Blythe','Cato','Merrit','Ellis','Finch','Garnet','Hux','Isola',
  'Season','Kade','Lior','Marnie','Niall','Onyx','Poe','Petrel','Reid','Sable','Toma','Ursa',
  'Vito','Wolf','Xilo','Yale','Zephyr','Amara','Boaz','Coen','Delphine','Emrys','Fitz','Gideon',
  'Corvin','Ivor','Jael','Kester','Liv','Marlowe','Ned','Oisin','Piran','Quirin','Rune','Seren',
  'Torin','Ulla','Vasq','Willa','Xerxes','Yosef','Zephyrine','Aiko','Blaise','Cai','Dree','Eowyn',
  'Fenris','Gael','Halcyon','Idris','Jarrah','Keir','Liora','Mireille','Niamh','Oskar','Petra','Quorra',
  'Rhosyn','Sorin','Tamsin','Amadi','Vianne','Wynn','Xochi','Corwin','Zaid','Anouk','Bora','Cirrus',
  'Dov','Elsen','Freya','Gwynn','Hesper','Isolde','Jareth','Kaia','Loki','Marek','Norah','Odette',
  'Pell','Quila','Rilke','Sela','Teigan','Ulyss','Vespera','Wrenna','Xylo','Yves','Zorion','Amiel',
  'Berit','Corin','Dashiell','Eiren','Farro','Gunnar','Danika','Inez','Jonas','Kestrel','Sarel','Mireio',
  'Nix','Oswin','Prue','Quist','Rasa','Sonder','Tavi','Bellamy','Vail','Wyndham','Xael','Yseult',
  'Zannah','Aleo','Bran','Coralie','Denis','Emmeline','Fennec','Garreth','Hiro','Innes','Jovan','Kellan',
  'Lasse','Marisol','Nils','Orsolya','Pravin','Quenby','Roan','Saoirse'
]

/**
 * Which project a workspace is a tab of.
 *
 * Falls back to `cwd`, so a workspace saved before projects existed — or one
 * opened on a folder that is not a repository at all — is a project of one
 * rather than a special case every caller has to handle.
 */
export function projectOf(w: Pick<Workspace, 'cwd' | 'projectRoot'>): string {
  return w.projectRoot ?? w.cwd
}

export const HUES = ['aqua', 'azure', 'violet', 'amber', 'rose', 'lime'] as const

export const DEFAULT_SETTINGS: Settings = {
  themeId: DEFAULT_THEME_ID,
  accentOverride: null,
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  fontSize: 12,
  // 1.0 is what Terminal.app uses. Anything taller stretches the cell, and the
  // block cursor stretches with it — that is what makes it look elongated.
  lineHeight: 1,
  shell: '',
  defaultAgentId: 'claude',
  bypassPermissions: true,
  // A filled block, the way Terminal.app does it — it inverts the character
  // underneath and stays legible at a glance across a grid of panes.
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 8000,
  confirmClose: true,
  reduceMotion: false,
  bellAttention: true,
  showWorkspaceTabs: true,
  foundThemes: [],

  voiceModelId: '',
  voiceMicId: '',
  voiceLanguage: 'auto',
  voiceSilenceMs: 1500,
  voiceHoldKey: 'MetaRight',

  speakOnFinish: false,
  speakVoice: '',
  speakRate: 180,
  speakVolume: 0.75,
  speakOnlyWhenAway: false,

  browserHome: 'http://localhost:5173',
  browserSearchEngine: DEFAULT_SEARCH_ENGINE,
  browserZoom: 1,

  usageFromAnthropic: false,
  usageSessionLimit: 0,
  usageWeekLimit: 0,

  // Nothing until a box is typed in; ~/.ssh/config is read fresh, not copied.
  sshHosts: []
}
