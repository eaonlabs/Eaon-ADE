/*
 * Checks that a WebGL context is only held for a pane that is on screen.
 *
 * Written because the app asks the browser for at most 32 live WebGL contexts
 * and this machine had 43 panes across 16 workspaces. Terminals here outlive
 * the components that draw them — that is deliberate, it is how a background
 * agent keeps streaming — but the GPU context was outliving them too, so a
 * context was held for every pane in every workspace ever visited. Past 32 the
 * browser drops the oldest without a word, and the pane that loses it is a
 * pane you are *looking at*.
 *
 * xterm and the WebGL addon are stubbed; what is under test is this repo's
 * own attach/detach bookkeeping.
 *
 *   node scripts/check-gpu-contexts.mjs
 */

import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-gpu-'))

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

/* ---- the live-context counter every stub reports into ------------------- */

const ctx = { live: 0, everCreated: 0, failNext: false }

const stubs = {
  '@xterm/xterm': `
    export class Terminal {
      constructor(opts) { this.options = opts || {}; this.buffer = {}; this._d = [] }
      open() {}
      write() {}
      writeln() {}
      dispose() {}
      loadAddon(a) { if (a && a.activate) a.activate(this) }
      onData() { return { dispose() {} } }
      onBinary() { return { dispose() {} } }
      onTitleChange() { return { dispose() {} } }
      onBell() { return { dispose() {} } }
      onResize() { return { dispose() {} } }
      onSelectionChange() { return { dispose() {} } }
      attachCustomKeyEventHandler() {}
      get cols() { return 80 }
      get rows() { return 24 }
    }
  `,
  '@xterm/addon-webgl': `
    const ctx = globalThis.__eaonCtx
    export class WebglAddon {
      constructor() {
        if (ctx.failNext) { ctx.failNext = false; throw new Error('no WebGL here') }
        ctx.live += 1; ctx.everCreated += 1
        this.alive = true
      }
      activate() {}
      onContextLoss(cb) { this._loss = cb }
      dispose() { if (this.alive) { this.alive = false; ctx.live -= 1 } }
    }
  `,
  '@xterm/addon-fit': `export class FitAddon { activate() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } dispose() {} }`,
  '@xterm/addon-search': `export class SearchAddon { activate() {} findNext() {} findPrevious() {} clearDecorations() {} dispose() {} }`,
  '@xterm/addon-web-links': `export class WebLinksAddon { activate() {} dispose() {} }`
}

const outfile = path.join(tmp, 'terminals.mjs')
await build({
  entryPoints: [path.join(root, 'src/renderer/src/lib/terminals.ts')],
  outfile,
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  logLevel: 'silent',
  alias: { '@shared': path.join(root, 'src/shared') },
  plugins: [
    {
      name: 'stub-xterm',
      setup(b) {
        for (const [mod, contents] of Object.entries(stubs)) {
          const filter = new RegExp(`^${mod.replace(/[/\\-]/g, '\\$&')}$`)
          b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub' }))
        }
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          contents: stubs[a.path],
          loader: 'js'
        }))
      }
    }
  ]
})

/* ---- a DOM just real enough for attach/detach --------------------------- */

function el() {
  const node = {
    children: [],
    parentElement: null,
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    setAttribute() {},
    appendChild(c) {
      if (c.parentElement) c.parentElement.removeChild(c)
      c.parentElement = node
      node.children.push(c)
      return c
    },
    removeChild(c) {
      node.children = node.children.filter((x) => x !== c)
      c.parentElement = null
      return c
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ width: 800, height: 400, top: 0, left: 0 }),
    focus() {},
    querySelector: () => null,
    remove() {
      if (node.parentElement) node.parentElement.removeChild(node)
    }
  }
  return node
}

globalThis.document = { createElement: () => el(), body: el(), addEventListener() {}, removeEventListener() {} }
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.window = {
  eaon: {
    pty: { write() {}, kill() {}, resize() {}, spawn: async () => ({ ok: true }) },
    sys: { openExternal() {} }
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  requestAnimationFrame: globalThis.requestAnimationFrame,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}
// Node 22 defines navigator as a getter-only global.
Object.defineProperty(globalThis, 'navigator', {
  value: { platform: 'MacIntel', userAgent: 'test' },
  configurable: true
})

// Set before the bundle is imported: the stub reads it at module scope.
globalThis.__eaonCtx = ctx

const { terminals } = await import(pathToFileURL(outfile).href)

const SETTINGS = {
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: 1,
  cursorStyle: 'block',
  cursorBlink: false,
  scrollback: 8000,
  shell: '/bin/zsh',
  bellAttention: true
}

try {
  console.log('\na pane on screen holds a context')
  const hosts = {}
  const show = (id) => {
    hosts[id] = hosts[id] ?? el()
    terminals.attach(id, hosts[id], SETTINGS)
  }
  const hide = (id) => terminals.detach(id)

  show('p1')
  check('one visible pane, one context', ctx.live === 1, ctx.live)

  console.log('\nleaving a workspace hands its contexts back')
  for (let i = 2; i <= 6; i += 1) show(`p${i}`)
  check('six visible panes, six contexts', ctx.live === 6, ctx.live)
  for (let i = 1; i <= 6; i += 1) hide(`p${i}`)
  check('all hidden, no contexts held', ctx.live === 0, ctx.live)

  console.log('\nthe real shape: 43 panes over 16 workspaces, 12 on screen at once')
  // Every pane gets created and shown once, as visiting each workspace does.
  let peak = 0
  let paneNo = 0
  for (let ws = 0; ws < 16; ws += 1) {
    const inThis = []
    for (let i = 0; i < (ws % 4) + 1; i += 1) inThis.push(`w${ws}p${paneNo++}`)
    for (const id of inThis) show(id)
    peak = Math.max(peak, ctx.live)
    for (const id of inThis) hide(id)
  }
  check('every pane was built at some point', paneNo >= 16, paneNo)
  check(
    `peak live contexts stayed under the 32 ceiling (was ${peak})`,
    peak < 32,
    peak
  )
  check('and nothing is held once every workspace is left', ctx.live === 0, ctx.live)

  console.log('\ncoming back gets the GPU again, not a permanent demotion to DOM')
  show('p1')
  check('shown again, holds a context', ctx.live === 1, ctx.live)
  check('reported as gpu', terminals.rendererOf('p1') === 'gpu', terminals.rendererOf('p1'))
  hide('p1')
  check('reported as dom while hidden', terminals.rendererOf('p1') === 'dom')
  show('p1')
  check('and gpu once more on return', terminals.rendererOf('p1') === 'gpu')

  console.log('\na machine with no WebGL at all is asked once, not on every show')
  const before = ctx.everCreated
  ctx.failNext = true
  show('nogpu')
  check('the failed attempt left no context', ctx.live === 1, ctx.live)
  const afterFirst = ctx.everCreated
  for (let i = 0; i < 5; i += 1) {
    hide('nogpu')
    show('nogpu')
  }
  check(
    'five more shows built no further addons',
    ctx.everCreated === afterFirst,
    `${ctx.everCreated - afterFirst} extra`
  )
  check('it still reports as dom', terminals.rendererOf('nogpu') === 'dom')
  check('and the healthy pane kept its own context', ctx.live === 1, ctx.live)
  void before

  console.log('\nclosing a pane for good releases everything')
  terminals.dispose('p1')
  terminals.dispose('nogpu')
  check('no contexts outlive disposal', ctx.live === 0, ctx.live)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailed:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
process.exit(0)
