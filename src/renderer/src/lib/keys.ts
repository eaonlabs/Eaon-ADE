/**
 * Which keypresses belong to Eaon ADE and which belong to the shell.
 *
 * macOS has two modifiers and no argument about it: ⌘ is the application's,
 * Control is the terminal's, and nothing collides. Windows and Linux have one.
 * Every bare Control chord already means something to the program you are
 * talking to — `Ctrl+D` ends input, `Ctrl+W` deletes a word, `Ctrl+K` kills a
 * line, `Ctrl+E` jumps to the end of it — so the app cannot take them. Doing so
 * would leave an agent you could not exit and a prompt you could not edit.
 *
 * So on Windows and Linux the app takes `Ctrl+Shift` and bare Control is always
 * the shell's. That is what Windows Terminal and VS Code do, and it is the one
 * arrangement a terminal user is not surprised by.
 *
 * Every binding lives here, once, because the alternative is two handlers — one
 * on the window, one inside each pane — quietly disagreeing about who owns a
 * key. That disagreement is invisible until a keystroke either does nothing or
 * does two things.
 */

export const IS_MAC =
  typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

/** Only the fields a binding decision reads, so it can be exercised directly. */
export interface KeyLike {
  type: string
  key: string
  code?: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

export type Command =
  | 'palette'
  | 'newWorkspace'
  | 'addPane'
  | 'closePane'
  | 'zoomPane'
  | 'conductor'
  | 'rail'
  | 'dock'
  | 'settings'
  | 'resume'
  | 'reopenTab'
  | 'dictate'
  | 'selectAll'
  | 'find'
  | 'fontIn'
  | 'fontOut'
  | 'fontReset'
  | `pane${number}`

/**
 * The physical key, independent of what the shift key did to it.
 *
 * `event.key` for Shift+1 is "!", and for Shift+, it is "<" — reading it would
 * make every shifted binding depend on the layout. `event.code` says which key
 * was struck.
 */
function physical(e: KeyLike): string | null {
  const code = e.code || ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6)
  switch (code) {
    case 'Comma':
      return ','
    case 'Slash':
      return '/'
    case 'Minus':
    case 'NumpadSubtract':
      return '-'
    case 'Equal':
    case 'NumpadAdd':
      return '='
    default:
      // Layouts that report no usable code still get the common letters.
      return /^[a-z0-9,/=+-]$/i.test(e.key) ? e.key.toLowerCase() : null
  }
}

/**
 * Font size, the way every terminal binds it: plain modifier, both platforms.
 *
 * Kept off the Ctrl+Shift scheme deliberately. `Ctrl+=` and `Ctrl+-` are what
 * Windows Terminal and VS Code use, they are not readline bindings, and moving
 * them would be a change nobody asked for. `Ctrl+Shift+-` stays unbound so that
 * readline's undo still reaches the shell.
 */
function fontCommand(e: KeyLike): Command | null {
  const primary = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey && !e.shiftKey
  if (!primary || e.altKey) return null
  const key = physical(e)
  if (key === '=' || key === '+') return 'fontIn'
  if (key === '-') return 'fontOut'
  if (key === '0') return 'fontReset'
  return null
}

/**
 * The two commands that are ⌘⇧ on macOS need their own letters elsewhere: with
 * Shift already spent on being the modifier, `Ctrl+Shift+B` cannot mean both
 * the sidebar and the side panel.
 */
const WINDOWS_ALIASES: Record<string, Command> = {
  o: 'dock', // ⌘⇧B
  m: 'dictate', // ⌘⇧D
  // ⌘⇧T. It cannot be Ctrl+Shift+T here: with one modifier combo that chord is
  // already ⌘T, which is New Workspace.
  r: 'reopenTab'
}

const SHARED: Record<string, Command> = {
  k: 'palette',
  t: 'newWorkspace',
  d: 'addPane',
  w: 'closePane',
  e: 'zoomPane',
  j: 'conductor',
  b: 'rail',
  a: 'selectAll',
  f: 'find',
  ',': 'settings',
  '/': 'resume'
}

/**
 * The command this keypress asks for, or null when it is the shell's.
 *
 * Returning null is the important half: an unbound chord must fall through
 * rather than be swallowed, or `Ctrl+Shift+-` would stop reaching readline.
 */
export function commandFor(e: KeyLike): Command | null {
  if (e.type !== 'keydown') return null

  const font = fontCommand(e)
  if (font) return font

  if (e.altKey) return null

  if (IS_MAC) {
    if (!e.metaKey || e.ctrlKey) return null
    const key = physical(e)
    if (!key) return null
    // ⌘⇧B and ⌘⇧D, which Windows reaches by another letter.
    if (e.shiftKey) {
      if (key === 'b') return 'dock'
      if (key === 'd') return 'dictate'
      // The chord every browser uses for this, which is the point of it.
      if (key === 't') return 'reopenTab'
      return null
    }
    if (/^[1-9]$/.test(key)) return `pane${Number(key)}`
    return SHARED[key] ?? null
  }

  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null
  const key = physical(e)
  if (!key) return null
  if (/^[1-9]$/.test(key)) return `pane${Number(key)}`
  return WINDOWS_ALIASES[key] ?? SHARED[key] ?? null
}

/** Modifier label for anything the app binds. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl+Shift+'

/** Modifier label for the font-size keys, which stay on the plain modifier. */
export const MOD_PLAIN = IS_MAC ? '⌘' : 'Ctrl+'

/** How a binding reads in the interface, given the command's macOS letter. */
export function shortcutLabel(macKey: string): string {
  if (IS_MAC) return `⌘${macKey.toUpperCase()}`
  const shifted = macKey.startsWith('⇧')
  const letter = shifted ? macKey.slice(1).toLowerCase() : macKey.toLowerCase()
  if (shifted) {
    const alias = Object.entries(WINDOWS_ALIASES).find(
      ([, cmd]) => (letter === 'b' && cmd === 'dock') || (letter === 'd' && cmd === 'dictate')
    )
    return `Ctrl+Shift+${(alias?.[0] ?? letter).toUpperCase()}`
  }
  return `Ctrl+Shift+${letter.toUpperCase()}`
}

/**
 * Hold-to-talk needs a key the operating system will actually give us.
 *
 * The stored default is Right ⌘, which on Windows is the Windows key — pressing
 * it opens the Start menu and the page never sees the release. Right Control is
 * the equivalent there: present on every keyboard, and unused on its own.
 */
export function effectiveHoldKey(setting: string): string {
  if (IS_MAC) return setting
  return setting === 'MetaRight' ? 'ControlRight' : setting
}
