/**
 * Themes.
 *
 * A theme is authored as a small spec — a background, a tint to build surfaces
 * from, a foreground, three status colours and the sixteen ANSI colours — and
 * expanded into the full token set the UI and the terminal both read from.
 * Authoring stays short; the derived ladder stays consistent across themes.
 *
 * Two colours carry meaning in every theme and must never be confused with each
 * other: `live` (an agent is working) and `attention` (it is waiting on you).
 *
 * Community palettes below are reproduced from their MIT-licensed projects, each
 * named in Settings › Appearance.
 */

export type ThemeMode = 'dark' | 'light'

export interface ThemeSpec {
  id: string
  name: string
  blurb: string
  mode: ThemeMode
  /** Pane body and terminal background. */
  bg: string
  /** App backdrop. Dark themes only; light themes derive it from `bg`. */
  deep?: string
  /** Colour that raised surfaces and hairlines are mixed toward. */
  raise: string
  /** Primary text. */
  fg: string
  accent: string
  /** An agent is producing output. */
  live: string
  /** An agent is waiting on a human. */
  attention: string
  danger: string
  cursor?: string
  /** black, red, green, yellow, blue, magenta, cyan, white, then the 8 bright. */
  ansi: readonly string[]
  /**
   * Kept out of the Appearance list until it has been found.
   *
   * Nothing is gated behind this — a secret theme is a theme. It is only
   * absent from the grid until `Settings.foundThemes` names it, and once
   * found it behaves like every other palette, including across restarts.
   */
  secret?: boolean
}

export interface ThemeTokens {
  ink000: string
  ink050: string
  ink100: string
  ink200: string
  ink300: string
  ink400: string
  ink500: string
  line100: string
  line200: string
  line300: string
  textHi: string
  textMid: string
  textLo: string
  textDim: string
  accent: string
  accentDim: string
  accentWash: string
  accentEdge: string
  onAccent: string
  live: string
  attention: string
  onAttention: string
  danger: string
  scrim: string
  glass: string
}

export interface TerminalPalette {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface Theme {
  id: string
  name: string
  blurb: string
  mode: ThemeMode
  tokens: ThemeTokens
  terminal: TerminalPalette
  secret?: boolean
}

// ---- colour helpers -----------------------------------------------------

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16)
  ]
}

function toHex([r, g, b]: [number, number, number]): string {
  const clamp = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`
}

/** t = 0 returns `a`, t = 1 returns `b`. */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = toRgb(a)
  const [r2, g2, b2] = toRgb(b)
  return toHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t])
}

function alpha(hex: string, a: number): string {
  const [r, g, b] = toRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** Perceived brightness, 0–255. Decides what text can sit on a colour. */
function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex)
  return 0.299 * r + 0.587 * g + 0.114 * b
}

// ---- expansion ----------------------------------------------------------

function buildTokens(spec: ThemeSpec): ThemeTokens {
  const { bg, raise, fg, mode } = spec
  const deep = spec.deep ?? bg

  const surfaces =
    mode === 'dark'
      ? {
          // Darkest at the back, panes lifted off it, menus lifted off panes.
          ink000: deep,
          ink050: mix(bg, deep, 0.72),
          ink100: mix(bg, deep, 0.42),
          ink200: bg,
          ink300: mix(bg, raise, 0.085),
          ink400: mix(bg, raise, 0.165),
          ink500: mix(bg, raise, 0.27)
        }
      : {
          // Inverted: a tinted backdrop, quieter chrome, and the pane itself
          // left at the base colour so terminal output sits on clean paper.
          ink000: mix(bg, raise, 0.085),
          ink050: mix(bg, raise, 0.05),
          ink100: mix(bg, raise, 0.025),
          ink200: bg,
          ink300: mix(bg, raise, 0.045),
          ink400: mix(bg, raise, 0.1),
          ink500: mix(bg, raise, 0.18)
        }

  const lineT = mode === 'dark' ? [0.1, 0.18, 0.3] : [0.15, 0.26, 0.4]

  return {
    ...surfaces,
    line100: mix(bg, raise, lineT[0]),
    line200: mix(bg, raise, lineT[1]),
    line300: mix(bg, raise, lineT[2]),
    textHi: fg,
    textMid: mix(fg, bg, 0.3),
    textLo: mix(fg, bg, 0.52),
    textDim: mix(fg, bg, 0.68),
    accent: spec.accent,
    accentDim: mix(spec.accent, bg, 0.45),
    accentWash: alpha(spec.accent, mode === 'dark' ? 0.1 : 0.12),
    accentEdge: alpha(spec.accent, 0.42),
    onAccent: luminance(spec.accent) > 150 ? mix(bg, '#000000', 0.55) : '#ffffff',
    live: spec.live,
    attention: spec.attention,
    onAttention: luminance(spec.attention) > 150 ? mix(bg, '#000000', 0.6) : '#ffffff',
    danger: spec.danger,
    scrim: mode === 'dark' ? alpha(deep, 0.72) : 'rgba(18, 22, 28, 0.42)',
    glass: alpha(surfaces.ink300, 0.94)
  }
}

function buildTerminal(spec: ThemeSpec): TerminalPalette {
  const a = spec.ansi
  return {
    background: spec.bg,
    foreground: mix(spec.fg, spec.bg, 0.1),
    cursor: spec.cursor ?? spec.accent,
    cursorAccent: spec.bg,
    selectionBackground: alpha(spec.accent, 0.26),
    black: a[0],
    red: a[1],
    green: a[2],
    yellow: a[3],
    blue: a[4],
    magenta: a[5],
    cyan: a[6],
    white: a[7],
    brightBlack: a[8],
    brightRed: a[9],
    brightGreen: a[10],
    brightYellow: a[11],
    brightBlue: a[12],
    brightMagenta: a[13],
    brightCyan: a[14],
    brightWhite: a[15]
  }
}

function build(spec: ThemeSpec): Theme {
  return {
    id: spec.id,
    name: spec.name,
    blurb: spec.blurb,
    mode: spec.mode,
    tokens: buildTokens(spec),
    terminal: buildTerminal(spec),
    secret: spec.secret
  }
}

// ---- the catalogue ------------------------------------------------------

const SPECS: ThemeSpec[] = [
  {
    // The brand palette: coral on ink, bone type, ash for everything secondary.
    id: 'ade',
    name: 'Ade',
    blurb: 'The house palette. Coral on ink, bone type.',
    mode: 'dark',
    bg: '#0f0f0f',
    deep: '#0a0a0a',
    raise: '#8a8781',
    fg: '#f4f2ee',
    accent: '#f17455',
    live: '#f17455',
    attention: '#f2c14e',
    danger: '#d9483b',
    ansi: [
      '#0f0f0f', '#d9483b', '#a3b86c', '#f2c14e', '#6e93b8', '#c98bb0', '#7fb5ad', '#d6d3cb',
      '#5c5a55', '#f17455', '#bcd18a', '#ffd977', '#8fb4d8', '#e3a8cb', '#9ed4cb', '#f4f2ee'
    ]
  },
  {
    id: 'superset',
    name: 'Superset',
    blurb: 'Warm near-black and terracotta, after superset.sh.',
    mode: 'dark',
    // Read out of the shipped app's own stylesheet rather than sampled off a
    // screenshot: `--background`, `--card`, `--foreground`, `--sidebar-primary`
    // and friends in Superset 1.29.0's renderer CSS. The greys are warm — every
    // one of them carries a little more red than green than blue — which is
    // what keeps the coral from reading as a sore thumb against them.
    bg: '#151110',
    deep: '#0f0c0b',
    // Its surfaces climb #1a1716 → #201e1c → #252220 → #2a2827; that ladder is
    // a warm grey pulled toward this, which is #2a2827's own hue carried up.
    raise: '#a8a5a3',
    fg: '#eae8e6',
    accent: '#e07850',
    live: '#5fb37f',
    attention: '#e5c07b',
    danger: '#cc4444',
    ansi: [
      '#151110', '#cc4444', '#5fb37f', '#e5c07b', '#7b9fd4', '#b48ead', '#6fb3b8', '#a8a5a3',
      '#4a4847', '#e07850', '#7ee787', '#f2cc60', '#79c0ff', '#d2a8ff', '#8fd4d8', '#eae8e6'
    ]
  },
  {
    id: 'ade-bone',
    name: 'Ade Bone',
    blurb: 'The house palette inverted, for daylight.',
    mode: 'light',
    bg: '#f4f2ee',
    raise: '#8a8781',
    fg: '#0f0f0f',
    accent: '#e05f3e',
    live: '#c2551f',
    attention: '#a8750f',
    danger: '#c0392b',
    ansi: [
      '#0f0f0f', '#c0392b', '#5f7a3a', '#a8750f', '#3f6b96', '#9c4f78', '#3d7d74', '#8a8781',
      '#5c5a55', '#d9483b', '#6f8f45', '#c08c1c', '#4e7fae', '#b25d8b', '#4a9187', '#0f0f0f'
    ]
  },
  {
    id: 'signal',
    name: 'Signal',
    blurb: 'Eaon’s own. Cold steel, aqua for anything running.',
    mode: 'dark',
    bg: '#14181f',
    deep: '#090b0e',
    raise: '#8fa3bd',
    fg: '#e9edf3',
    accent: '#4de1c1',
    live: '#4de1c1',
    attention: '#f5a65b',
    danger: '#f0565c',
    ansi: [
      '#14181f', '#f0565c', '#4de1c1', '#f5a65b', '#5b8cff', '#a78bfa', '#5ed3e0', '#c9d1de',
      '#5d6776', '#ff7a80', '#7defd1', '#ffc286', '#85a9ff', '#c4aefc', '#8ae4ee', '#e9edf3'
    ]
  },
  {
    id: 'void',
    name: 'Void',
    blurb: 'Pure black. Nothing on screen but the work.',
    mode: 'dark',
    bg: '#000000',
    deep: '#000000',
    raise: '#8c8c8c',
    fg: '#ededed',
    accent: '#f4f4f4',
    live: '#7ee787',
    attention: '#ffa657',
    danger: '#ff7b72',
    ansi: [
      '#000000', '#ff7b72', '#7ee787', '#e3b341', '#79c0ff', '#d2a8ff', '#76e3ea', '#c9d1d9',
      '#6e7681', '#ffa198', '#8ff5a0', '#f2cc60', '#a5d6ff', '#e2c5ff', '#9defe5', '#f0f6fc'
    ]
  },
  {
    id: 'cyber-wave',
    name: 'Cyber Wave',
    blurb: 'Deep teal with neon highlights.',
    mode: 'dark',
    bg: '#071c22',
    deep: '#030f13',
    raise: '#4fd6e0',
    fg: '#d9f4f7',
    accent: '#7c6cff',
    live: '#22e0c4',
    attention: '#ffb454',
    danger: '#ff5c7c',
    ansi: [
      '#071c22', '#ff5c7c', '#22e0c4', '#ffb454', '#59a6ff', '#7c6cff', '#4fd6e0', '#bfe6ea',
      '#3d6a74', '#ff87a0', '#5cf0da', '#ffd08a', '#8cc4ff', '#a79bff', '#86ecf5', '#eafcff'
    ]
  },
  {
    id: 'ember',
    name: 'Ember',
    blurb: 'Warm charcoal and copper. Cyan when you are needed.',
    mode: 'dark',
    bg: '#1a1512',
    deep: '#0f0c0a',
    raise: '#c9a17a',
    fg: '#f3e9df',
    accent: '#e8833a',
    live: '#e8833a',
    attention: '#62d0ff',
    danger: '#ef5f5f',
    ansi: [
      '#1a1512', '#ef5f5f', '#9fc36a', '#e8b44a', '#62d0ff', '#d98ac0', '#63c9b4', '#e3d5c6',
      '#6f6055', '#ff8080', '#bcdd8b', '#ffd06e', '#8fdeff', '#f0a7d8', '#86e3d0', '#fff6ec'
    ]
  },
  {
    id: 'graphite',
    name: 'Graphite',
    blurb: 'Greyscale interface. Colour only where it means something.',
    mode: 'dark',
    bg: '#17191c',
    deep: '#0e1012',
    raise: '#9aa1aa',
    fg: '#e6e8ea',
    accent: '#c3c9d1',
    live: '#8fd0a8',
    attention: '#e0a458',
    danger: '#e07a7a',
    ansi: [
      '#17191c', '#e07a7a', '#8fd0a8', '#e0a458', '#8fb4d4', '#b5a5cc', '#8ecbd0', '#c9ccd1',
      '#5b6068', '#f09a9a', '#a9e0c0', '#f0c07e', '#a9cbe6', '#cbbde0', '#a9dee2', '#f2f4f6'
    ]
  },
  {
    id: 'deep-sea',
    name: 'Deep Sea',
    blurb: 'Midnight navy, sky-blue accents.',
    mode: 'dark',
    bg: '#0d1b2a',
    deep: '#071320',
    raise: '#7bb0d8',
    fg: '#dbe8f5',
    accent: '#38bdf8',
    live: '#38bdf8',
    attention: '#fbbf24',
    danger: '#fb7185',
    ansi: [
      '#0d1b2a', '#fb7185', '#4ade80', '#fbbf24', '#38bdf8', '#a78bfa', '#22d3ee', '#c3d4e6',
      '#4a6580', '#fda4af', '#86efac', '#fcd34d', '#7dd3fc', '#c4b5fd', '#67e8f9', '#eef6ff'
    ]
  },
  {
    id: 'dracula',
    name: 'Dracula',
    blurb: 'The classic — purple dusk with a pink accent.',
    mode: 'dark',
    bg: '#282a36',
    deep: '#21222c',
    raise: '#6272a4',
    fg: '#f8f8f2',
    accent: '#ff79c6',
    live: '#50fa7b',
    attention: '#ffb86c',
    danger: '#ff5555',
    ansi: [
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'
    ]
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    blurb: 'Retro warmth, amber accents.',
    mode: 'dark',
    bg: '#282828',
    deep: '#1d2021',
    raise: '#a89984',
    fg: '#ebdbb2',
    accent: '#fe8019',
    live: '#b8bb26',
    attention: '#fabd2f',
    danger: '#fb4934',
    ansi: [
      '#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'
    ]
  },
  {
    id: 'nord',
    name: 'Nord',
    blurb: 'Arctic blues, low contrast, easy on long sessions.',
    mode: 'dark',
    bg: '#2e3440',
    deep: '#272c36',
    raise: '#7b8ca8',
    fg: '#e5e9f0',
    accent: '#88c0d0',
    live: '#a3be8c',
    attention: '#ebcb8b',
    danger: '#bf616a',
    ansi: [
      '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'
    ]
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    blurb: 'City-at-night blues with a soft glow.',
    mode: 'dark',
    bg: '#1a1b26',
    deep: '#16161e',
    raise: '#565f89',
    fg: '#c0caf5',
    accent: '#7aa2f7',
    live: '#9ece6a',
    attention: '#e0af68',
    danger: '#f7768e',
    ansi: [
      '#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
      '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'
    ]
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    blurb: 'Soft pastels on a warm dark base.',
    mode: 'dark',
    bg: '#1e1e2e',
    deep: '#181825',
    raise: '#6c7086',
    fg: '#cdd6f4',
    accent: '#cba6f7',
    live: '#a6e3a1',
    attention: '#f9e2af',
    danger: '#f38ba8',
    ansi: [
      '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
      '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'
    ]
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    blurb: 'The editor standard, brought to the terminal.',
    mode: 'dark',
    bg: '#282c34',
    deep: '#21252b',
    raise: '#5c6370',
    fg: '#abb2bf',
    accent: '#61afef',
    live: '#98c379',
    attention: '#e5c07b',
    danger: '#e06c75',
    ansi: [
      '#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
      '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'
    ]
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    blurb: 'Muted plum and rose. Quiet all the way down.',
    mode: 'dark',
    bg: '#191724',
    deep: '#16141f',
    raise: '#6e6a86',
    fg: '#e0def4',
    accent: '#c4a7e7',
    live: '#9ccfd8',
    attention: '#f6c177',
    danger: '#eb6f92',
    ansi: [
      '#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4',
      '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4'
    ]
  },
  {
    id: 'daylight',
    name: 'Daylight',
    blurb: 'Clean and bright for working in a sunny room.',
    mode: 'light',
    bg: '#ffffff',
    raise: '#64748b',
    fg: '#0f172a',
    accent: '#0284c7',
    live: '#059669',
    attention: '#d97706',
    danger: '#dc2626',
    ansi: [
      '#1e293b', '#dc2626', '#059669', '#d97706', '#0284c7', '#9333ea', '#0891b2', '#475569',
      '#64748b', '#ef4444', '#10b981', '#f59e0b', '#0ea5e9', '#a855f7', '#06b6d4', '#0f172a'
    ]
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    blurb: 'Paper-warm, engineered for readability.',
    mode: 'light',
    bg: '#fdf6e3',
    raise: '#93a1a1',
    fg: '#073642',
    accent: '#268bd2',
    live: '#859900',
    attention: '#b58900',
    danger: '#dc322f',
    ansi: [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#586e75', '#cb4b16', '#93a1a1', '#839496', '#657b83', '#6c71c4', '#93a1a1', '#fdf6e3'
    ]
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    blurb: 'The pastel palette, lightened for daylight.',
    mode: 'light',
    bg: '#eff1f5',
    raise: '#8c8fa1',
    fg: '#4c4f69',
    accent: '#8839ef',
    live: '#40a02b',
    attention: '#df8e1d',
    danger: '#d20f39',
    ansi: [
      '#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be',
      '#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc'
    ]
  },
  {
    /*
     * Not in the Appearance grid until it is found. See `secret` above.
     *
     * A P1 phosphor tube was monochrome, so the honest version of this palette
     * would map all sixteen ANSI slots onto one green and make every syntax
     * highlighter useless. These hues stay inside the green-amber end of the
     * spectrum a phosphor tube actually reached, but keep enough separation
     * that a diff still reads as a diff. Nostalgia stops where legibility does.
     */
    id: 'phosphor',
    name: 'Phosphor',
    blurb: 'P1 green on black, the way the tube did it.',
    mode: 'dark',
    secret: true,
    bg: '#0b100c',
    deep: '#060a07',
    raise: '#6f9a78',
    fg: '#c9f2cf',
    accent: '#3ef07a',
    live: '#3ef07a',
    attention: '#e8e45c',
    danger: '#ff6b5e',
    cursor: '#3ef07a',
    ansi: [
      '#0b100c', '#e2705f', '#4fd97a', '#d8c85f', '#6fa8a0', '#a9c07e', '#5fd0b4', '#b8d8bd',
      '#3a4a3d', '#ff8a76', '#6ff09a', '#f0e07a', '#8fc4bb', '#c6dc9a', '#7ae8cc', '#dff5e4'
    ]
  }
]

export const THEMES: Theme[] = SPECS.map(build)

export const DEFAULT_THEME_ID = 'ade'

export function getTheme(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** Optional accent overrides, offered on top of whatever theme is active. */
export const ACCENT_OVERRIDES: { id: string; label: string; hex: string }[] = [
  { id: 'aqua', label: 'Aqua', hex: '#4de1c1' },
  { id: 'azure', label: 'Azure', hex: '#5b8cff' },
  { id: 'violet', label: 'Violet', hex: '#a78bfa' },
  { id: 'amber', label: 'Amber', hex: '#f5a65b' },
  { id: 'rose', label: 'Rose', hex: '#f472b6' },
  { id: 'lime', label: 'Lime', hex: '#9fe05f' }
]

/** Rebuilds the accent-derived tokens when the user overrides the accent. */
export function withAccent(theme: Theme, accentHex: string): Theme {
  return {
    ...theme,
    tokens: {
      ...theme.tokens,
      accent: accentHex,
      accentDim: mix(accentHex, theme.terminal.background, 0.45),
      accentWash: alpha(accentHex, theme.mode === 'dark' ? 0.1 : 0.12),
      accentEdge: alpha(accentHex, 0.42),
      onAccent:
        luminance(accentHex) > 150 ? mix(theme.terminal.background, '#000000', 0.55) : '#ffffff'
    },
    terminal: {
      ...theme.terminal,
      cursor: accentHex,
      selectionBackground: alpha(accentHex, 0.26)
    }
  }
}
