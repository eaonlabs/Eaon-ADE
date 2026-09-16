/**
 * Things you can find if you go looking.
 *
 * Four of them, each borrowed from somewhere a developer has already been:
 *
 *   konami  ↑↑↓↓←→←→BA      Contra, 1988. Unlocks the Phosphor theme.
 *   xyzzy                    Colossal Cave Adventure, 1976. Prints the machine.
 *   quit    :q :wq :q!       vi, 1976. Leaves Settings.
 *   sudo    (in the search)  Handled at the search box, not here.
 *
 * None of them gate anything. An easter egg that withholds a feature is a
 * puzzle the user did not ask to be set; these only ever add.
 */

import { useEffect, useRef } from 'react'

export type Lore = 'konami' | 'xyzzy' | 'quit'

/**
 * The sequences, longest first.
 *
 * Matching is longest-first so `:q!` is seen as itself and not as `:q`
 * followed by a stray `!` — otherwise the bang could never be typed.
 */
const SEQUENCES: { lore: Lore; keys: string[] }[] = [
  {
    lore: 'konami',
    keys: [
      'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
      'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
      'b', 'a'
    ]
  },
  { lore: 'xyzzy', keys: ['x', 'y', 'z', 'z', 'y'] },
  { lore: 'quit', keys: [':', 'w', 'q', '!'] },
  { lore: 'quit', keys: [':', 'w', 'q'] },
  { lore: 'quit', keys: [':', 'q', '!'] },
  { lore: 'quit', keys: [':', 'q'] }
]

/** Longest sequence in the table; the buffer never needs to be deeper. */
const DEPTH = Math.max(...SEQUENCES.map((s) => s.keys.length))

/**
 * A printable key is compared case-insensitively; a named key (`ArrowUp`,
 * `Shift`) keeps its name. Shift itself is dropped — holding it to reach `:`
 * would otherwise land in the buffer and break the sequence that needs it.
 */
function normalise(e: KeyboardEvent): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  const k = e.key
  if (k === 'Shift' || k === 'CapsLock' || k === 'Unidentified') return null
  return k.length === 1 ? k.toLowerCase() : k
}

/** True while the keystroke belongs to something the user is typing into. */
function typingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

/**
 * Watch for the sequences above while `active`, and call `onFound` once per
 * completed one.
 *
 * Keystrokes aimed at a field are ignored outright — typing "xyzzy" into the
 * search box is a search for xyzzy, and a settings pane that reacted to what
 * you typed somewhere else would be a bug wearing a joke's clothes.
 */
export function useKeyLore(active: boolean, onFound: (lore: Lore) => void): void {
  // Held in a ref so a found sequence does not re-subscribe the listener and
  // lose the buffer with it.
  const buffer = useRef<string[]>([])
  const handler = useRef(onFound)
  handler.current = onFound

  useEffect(() => {
    if (!active) {
      buffer.current = []
      return
    }
    const onKey = (e: KeyboardEvent): void => {
      if (typingInto(e.target)) {
        buffer.current = []
        return
      }
      const key = normalise(e)
      if (!key) return

      const next = [...buffer.current, key].slice(-DEPTH)
      buffer.current = next

      const tail = next.join(' ')
      const hit = SEQUENCES.find((s) => tail.endsWith(s.keys.join(' ')))
      if (!hit) return
      // Clear, so holding the last key does not fire it over and over.
      buffer.current = []
      handler.current(hit.lore)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}

/**
 * The sudo line, quoted the way sudo actually says it.
 *
 * Shown in place of "nothing matching" when the search is a sudo attempt —
 * `sudo`, or `sudo <anything>`. The real message names the user and the host;
 * this one does not, because the joke does not need their machine's name and
 * a settings pane is not the place to print it.
 */
export const SUDOERS = 'is not in the sudoers file. This incident has been reported.'

export function isSudo(query: string): boolean {
  return /^\s*sudo\b/i.test(query)
}
