/**
 * Drives an installed Eaon ADE and checks it actually works.
 *
 * A build that packages is not a build that runs. Everything interesting here
 * is native — the pty (ConPTY on Windows, forkpty elsewhere), the GPU renderer,
 * the preload bridge — and none of it can be exercised on the machine that
 * cross-builds it. So this runs against a real installation on a real machine
 * of that platform, attaches over the DevTools protocol, and asks the running
 * app the questions that matter: did the window mount, is the bridge wired up,
 * and can it open a shell and get output back from it.
 *
 * Nothing in here is platform-specific: it spawns the executable it is given
 * and talks to it over a port. Both the Windows and Linux workflows use it.
 *
 *   node scripts/smoke-app.mjs "C:\\path\\to\\Eaon ADE.exe"
 *   node scripts/smoke-app.mjs ./dist/linux-unpacked/eaon-ade
 */
import { spawn } from 'node:child_process'

const EXE = process.argv[2]
const PORT = Number(process.env.SMOKE_PORT || 9222)

if (!EXE) {
  console.error('usage: node scripts/smoke-app.mjs <path to the Eaon ADE executable>')
  process.exit(1)
}

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`PASS  ${label}`)
  } else {
    fail += 1
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log(`launching ${EXE}`)
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
  detached: false,
  stdio: ['ignore', 'pipe', 'pipe']
})
let appStderr = ''
child.stdout?.on('data', (d) => (appStderr += d.toString()))
child.stderr?.on('data', (d) => (appStderr += d.toString()))
child.on('error', (err) => {
  console.error(`could not start the app: ${err.message}`)
  process.exit(1)
})

/** The renderer target, once the app has one. */
async function renderer(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(`the app exited on its own with code ${child.exitCode}`)
      console.error(appStderr.slice(-4000))
      return null
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* not listening yet */
    }
    await sleep(1000)
  }
  return null
}

const page = await renderer(120000)
check('the app starts and opens a window', Boolean(page), page ? undefined : appStderr.slice(-2000))
if (!page) {
  child.kill()
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

let nextId = 1
function send(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 90000)
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMsg)
      resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (res?.exceptionDetails) {
    return { __error: res.exceptionDetails.exception?.description ?? 'threw' }
  }
  return res?.result?.value
}

// Wait for the renderer to finish mounting rather than guessing at a delay.
const mounted = await evaluate(`
  new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (document.querySelector('.app')) return resolve(true)
      if (Date.now() - started > 60000) return resolve(false)
      setTimeout(tick, 250)
    }
    tick()
  })
`)
check('the interface mounts', mounted === true, mounted)

// A promise, not an await: the expression is evaluated as an ordinary one, so
// a top-level await in it is a syntax error rather than a wait.
const env = await evaluate(`
  new Promise((resolve) => {
    const base = {
      platform: navigator.platform,
      hasBridge: typeof window.eaon === 'object' && window.eaon !== null,
      bridge: window.eaon ? Object.keys(window.eaon).sort() : []
    }
    if (!base.hasBridge || !window.eaon.sys) return resolve(base)
    window.eaon.sys
      .info()
      .then((i) => resolve(Object.assign({ version: i && i.version }, base)))
      .catch(() => resolve(base))
  })
`)
/*
 * Which platform the *app* thinks it is on, which is the thing worth checking:
 * a build that reports the wrong one has picked the wrong shell, the wrong
 * keymap and the wrong window chrome. TARGET says what this run expects, and
 * defaults to the platform the harness is running on.
 */
const TARGET = process.env.SMOKE_PLATFORM || (process.platform === 'win32' ? 'win32' : process.platform)
const EXPECT = { win32: 'Win', linux: 'Linux', darwin: 'Mac' }[TARGET] ?? 'Linux'
check(
  `it knows it is on ${TARGET}`,
  String(env?.platform || '').startsWith(EXPECT),
  env?.platform
)
check('the preload bridge is attached', env?.hasBridge === true, env)
for (const api of ['pty', 'stats', 'brain', 'sessions']) {
  check(`the ${api} bridge is present`, (env?.bridge ?? []).includes(api), env?.bridge)
}

// The one that matters: a real pseudo-terminal, through ConPTY, running the
// shell this app picks on Windows, echoing something back.
const pty = await evaluate(`
  new Promise((resolve) => {
    const id = 'smoke-' + Date.now()
    let out = ''
    const off = window.eaon.pty.onData((pane, data) => { if (pane === id) out += data })
    const finish = (extra) => {
      try { off() } catch {}
      try { window.eaon.pty.kill(id) } catch {}
      resolve(Object.assign({ output: out.slice(-600) }, extra))
    }
    window.eaon.pty.spawn({ paneId: id, cwd: '.', cols: 100, rows: 30 }).then((r) => {
      if (!r || !r.ok) return finish({ spawned: false, error: r && r.error })
      // Let the shell print its prompt before typing at it.
      setTimeout(() => {
        window.eaon.pty.write(id, 'echo EAON_PTY_OK\\r\\n')
        setTimeout(() => finish({ spawned: true }), 8000)
      }, 5000)
    }).catch((e) => finish({ spawned: false, error: String(e) }))
  })
`)
check('a pseudo-terminal spawns', pty?.spawned === true, pty?.error ?? pty)
check(
  'the shell echoes back through the pty',
  typeof pty?.output === 'string' && pty.output.includes('EAON_PTY_OK'),
  pty?.output
)
/*
 * And that it chose a sensible shell for the platform. On Windows that means
 * PowerShell rather than cmd.exe; on Linux it means the user's login shell,
 * which the prompt in the captured output identifies. The Linux case is the
 * one worth guarding: the old fallback was /bin/zsh, which most distributions
 * do not ship, and a pane that cannot spawn fails here.
 */
if (TARGET === 'win32') {
  check(
    'the shell it picked is PowerShell',
    typeof pty?.output === 'string' && /PS\s|PowerShell/i.test(pty.output),
    pty?.output?.slice(0, 200)
  )
} else {
  check(
    'the shell it picked is a working login shell',
    typeof pty?.output === 'string' && /\$|%|#/.test(pty.output),
    pty?.output?.slice(0, 200)
  )
}

// The Windows keymap, as the running app reports it rather than as tested here.
const keys = await evaluate(`
  new Promise((resolve) => {
    const seen = []
    const listener = (e) => seen.push(e.defaultPrevented)
    window.addEventListener('keydown', listener)
    const fire = (init) => window.dispatchEvent(
      new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init))
    )
    fire({ key: 'd', code: 'KeyD', ctrlKey: true })
    const ctrlDTaken = seen[seen.length - 1] === true
    fire({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true })
    const ctrlShiftKTaken = seen[seen.length - 1] === true
    window.removeEventListener('keydown', listener)
    setTimeout(() => resolve({ ctrlDTaken, ctrlShiftKTaken, overlay: !!document.querySelector('.scrim') }), 500)
  })
`)
check('bare Ctrl+D is left to the shell', keys?.ctrlDTaken === false, keys)
check('Ctrl+Shift+K is taken by the app', keys?.ctrlShiftKTaken === true, keys)
check('Ctrl+Shift+K opened the commands', keys?.overlay === true, keys)

// The window has to fit the screen it opened on, and the title bar has to
// leave room for the controls Windows draws over it. Both were wrong: a fixed
// 1560x980 window is larger than a 1920x1080 laptop's work area at the 150%
// scaling Windows picks by default, and the app's own buttons sat underneath
// the minimise/maximise/close overlay where they could not be clicked.
const fit = await evaluate(`
  new Promise((resolve) => {
    const bar = document.querySelector('.titlebar')
    const styles = bar ? getComputedStyle(bar) : null
    const wco = navigator.windowControlsOverlay
    const rect = wco && wco.visible ? wco.getTitlebarAreaRect() : null
    resolve({
      screenW: window.screen.availWidth,
      screenH: window.screen.availHeight,
      outerW: window.outerWidth,
      outerH: window.outerHeight,
      padRight: styles ? parseInt(styles.paddingRight, 10) : null,
      overlayVisible: Boolean(wco && wco.visible),
      controlsWidth: rect ? Math.round(window.innerWidth - (rect.x + rect.width)) : null,
      actionsRight: (() => {
        const a = document.querySelector('.titlebar-actions')
        if (!a) return null
        const r = a.getBoundingClientRect()
        return Math.round(window.innerWidth - r.right)
      })()
    })
  })
`)

check(
  'the window fits the screen it opened on',
  fit && fit.outerW <= fit.screenW && fit.outerH <= fit.screenH,
  fit && `window ${fit.outerW}x${fit.outerH} vs screen ${fit.screenW}x${fit.screenH}`
)
check('the window controls overlay is reported', fit?.overlayVisible === true, fit)
check(
  'the title bar leaves room for the window controls',
  fit && fit.controlsWidth > 0 && fit.padRight >= fit.controlsWidth,
  fit && `padding-right ${fit.padRight} for controls ${fit.controlsWidth}`
)
check(
  'the app buttons clear the window controls',
  fit && fit.actionsRight !== null && fit.actionsRight >= fit.controlsWidth,
  fit && `actions end ${fit.actionsRight}px from the edge, controls take ${fit.controlsWidth}px`
)

const title = await evaluate(`document.title || document.querySelector('.wordmark')?.textContent || ''`)
check('the window identifies itself', typeof title === 'string' && title.length > 0, title)

ws.close()
child.kill()
await sleep(1500)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
