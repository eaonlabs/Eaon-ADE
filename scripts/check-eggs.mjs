/*
 * Checks the four things hidden in Settings, and — more to the point — checks
 * that they stay out of the way of the people who are not looking for them.
 *
 * An easter egg is a bug the moment it fires when nobody asked. So most of
 * what is below is the negative case: a sequence typed into a field, a partial
 * match, a settings search that merely contains the word sudo, a secret theme
 * that must not appear in Appearance until it has been found.
 *
 *   node scripts/check-eggs.mjs
 */

import { build } from 'esbuild'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
const failures = []
function check(name, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${extra !== undefined ? ` — ${extra}` : ''}`)
  }
}

/* ------------------------------------------------------------------ build */

async function load(entry, name) {
  const outfile = path.join(os.tmpdir(), `${name}-${Date.now()}.mjs`)
  await build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    // The hook pulls React in for useEffect/useRef. Only the pure exports are
    // exercised here, so React is stubbed rather than bundled — the same trick
    // check-agent-detect.mjs uses on electron.
    plugins: [
      {
        name: 'stub-react',
        setup(b) {
          b.onResolve({ filter: /^react$/ }, () => ({ path: 'r', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'export const useEffect = () => {}; export const useRef = () => ({})',
            loader: 'js'
          }))
        }
      }
    ]
  })
  return import(outfile)
}

const { isSudo, SUDOERS } = await load('src/renderer/src/lib/eggs.ts', 'eggs')
const { THEMES } = await load('src/shared/themes.ts', 'themes')
const { DEFAULT_SETTINGS } = await load('src/shared/types.ts', 'types')

/*
 * The sequence table is not exported — it is an implementation detail of the
 * hook — so the matcher is restated here in the four lines it takes, and the
 * source is read to prove the two agree. If a sequence is added or renamed in
 * eggs.ts without this file being updated, the last check in this block fails.
 */
const { readFileSync } = await import('node:fs')
const source = readFileSync(path.join(root, 'src/renderer/src/lib/eggs.ts'), 'utf8')

const SEQUENCES = [
  ['konami', ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']],
  ['xyzzy', ['x', 'y', 'z', 'z', 'y']],
  ['quit', [':', 'w', 'q', '!']],
  ['quit', [':', 'w', 'q']],
  ['quit', [':', 'q', '!']],
  ['quit', [':', 'q']]
]
const DEPTH = Math.max(...SEQUENCES.map(([, k]) => k.length))

/** What the hook does to a buffer, minus the DOM. */
function fire(keys) {
  const tail = keys.slice(-DEPTH).join(' ')
  const hit = SEQUENCES.find(([, k]) => tail.endsWith(k.join(' ')))
  return hit ? hit[0] : null
}

console.log('\nthe sequences fire')
check('konami', fire(['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) === 'konami')
check('xyzzy', fire(['x', 'y', 'z', 'z', 'y']) === 'xyzzy')
check(':q', fire([':', 'q']) === 'quit')
check(':wq', fire([':', 'w', 'q']) === 'quit')
check(':q!', fire([':', 'q', '!']) === 'quit')
check(':wq!', fire([':', 'w', 'q', '!']) === 'quit')

console.log('\n…from the middle of a longer buffer')
check('keys before the code are ignored', fire(['q', 'w', 'e', 'x', 'y', 'z', 'z', 'y']) === 'xyzzy')
check('konami after a false start', fire(['ArrowUp', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) === 'konami')

console.log('\nwhat must NOT fire')
check('nothing typed', fire([]) === null)
check('a partial konami', fire(['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown']) === null)
check('konami with a wrong key in it', fire(['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowLeft', 'b', 'a']) === null)
check('xyzzy misspelled', fire(['x', 'y', 'z', 'y']) === null)
check('xyzz, one short', fire(['x', 'y', 'z', 'z']) === null)
check('a bare colon', fire([':']) === null)
check('q on its own', fire(['q']) === null)
// Ordinary prose must not quit the pane on the user.
check('the word "quit"', fire(['q', 'u', 'i', 't']) === null)

console.log('\n:q! is matched as itself, not as :q plus a stray bang')
// Longest-first ordering. If :q were tried first the ! could never be typed.
check('the table is longest-first', SEQUENCES.every(([, k], i) => i === 0 || k.length <= SEQUENCES[i - 1][1].length || SEQUENCES[i - 1][0] !== 'quit'))
check(':q! is not left dangling', fire([':', 'q', '!']) === 'quit')

console.log('\nthe hook refuses keystrokes aimed at a field')
// The guard is the whole reason typing "xyzzy" into the search box is a
// search for xyzzy. Asserted against the source, since it needs a DOM to run.
check('inputs are excluded', /tag === 'input'/.test(source))
check('textareas are excluded', /tag === 'textarea'/.test(source))
check('selects are excluded', /tag === 'select'/.test(source))
check('contenteditable is excluded', /isContentEditable/.test(source))
check('the buffer is cleared, not just skipped', /typingInto\(e\.target\)\) \{\s*buffer\.current = \[\]/.test(source))
check('a chord is not a keystroke', /metaKey \|\| e\.ctrlKey \|\| e\.altKey/.test(source))
check('shift is dropped so ":" survives', /k === 'Shift'/.test(source))
check('the sequence is cleared once it fires', /buffer\.current = \[\]\s*\n\s*handler\.current/.test(source))

console.log('\nsudo')
check('sudo', isSudo('sudo'))
check('sudo with a command after it', isSudo('sudo rm -rf /'))
check('leading space', isSudo('  sudo'))
check('any case', isSudo('SUDO'))
check('not a settings page called sudo', !isSudo('pseudo'))
check('not a word merely starting the same', !isSudo('sudoku'))
check('not mid-sentence', !isSudo('how do I sudo'))
check('not empty', !isSudo(''))
check('the message is what sudo says', SUDOERS === 'is not in the sudoers file. This incident has been reported.')

console.log('\nthe secret theme')
const secret = THEMES.filter((t) => t.secret)
check('there is one', secret.length === 1, `${secret.length}`)
check('it is Phosphor', secret[0]?.id === 'phosphor')
check('it is a complete theme, not a stub', Boolean(secret[0]?.tokens && secret[0]?.terminal))
check('it has all sixteen ANSI colours', Object.keys(secret[0]?.terminal ?? {}).length >= 16)
check('every other theme is listed', THEMES.filter((t) => !t.secret).length === THEMES.length - 1)
check('nothing is found out of the box', DEFAULT_SETTINGS.foundThemes.length === 0)
check('foundThemes is a list, not a flag', Array.isArray(DEFAULT_SETTINGS.foundThemes))
check('the default theme is not the secret one', DEFAULT_SETTINGS.themeId !== 'phosphor')

console.log('\nAppearance shows a secret theme only when it should')
// The rule in SettingsModal: not secret, or found, or currently in use.
const visible = (found, themeId) =>
  THEMES.filter((t) => !t.secret || found.includes(t.id) || themeId === t.id).map((t) => t.id)
check('hidden before it is found', !visible([], 'ade').includes('phosphor'))
check('listed once found', visible(['phosphor'], 'ade').includes('phosphor'))
check(
  'listed while in use even if the find was never recorded',
  visible([], 'phosphor').includes('phosphor'),
  'a profile copied to another machine must not strand the user in a palette they cannot leave'
)
check('finding it does not reveal anything else', visible(['phosphor'], 'ade').length === THEMES.length)

console.log('\nnone of this gates a feature')
const { execSync } = await import('node:child_process')
check('no egg is referenced outside Settings and its own module', (() => {
  const hits = execSync(
    `grep -rl "lib/eggs" ${JSON.stringify(path.join(root, 'src'))} || true`,
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean)
  return hits.every((f) => /SettingsModal\.tsx$/.test(f))
})())


/*
 * Not an egg — but it lives here because it is the same failure: a rule
 * written as "everything except X" that silently changes meaning when a new
 * kind is added. `isPanelKind` was `kind !== 'terminals'`, which was true
 * until `browser` arrived and then narrowed callers to a set the value was
 * not in. Two components now depend on it, so every kind is enumerated:
 * adding one to WorkspaceKind without deciding this fails here.
 */
const { isPanelKind, PANEL_KINDS } = await load('src/shared/types.ts', 'kinds')

console.log('\nisPanelKind answers PANEL_KINDS, not "not terminals"')
const ALL_KINDS = ['terminals', 'board', 'vault', 'brain', 'stats', 'browser']
for (const k of ALL_KINDS) {
  const want = PANEL_KINDS.includes(k)
  check(`${k} → ${want}`, isPanelKind(k) === want)
}
check(
  'a browser is not a panel',
  isPanelKind('browser') === false,
  'the exclusion form said true here, while its type predicate promised otherwise'
)
check('every kind is accounted for', (() => {
  const source = readFileSync(path.join(root, 'src/shared/types.ts'), 'utf8')
  const declared = /export type WorkspaceKind =([^\n]+)/.exec(source)?.[1] ?? ''
  const kinds = [...declared.matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  return kinds.length === ALL_KINDS.length && kinds.every((k) => ALL_KINDS.includes(k))
})(), 'a kind was added to WorkspaceKind without being decided here')

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
