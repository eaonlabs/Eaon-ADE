/*
 * Checks the things that decide whether this app works on Linux, from a
 * machine that is probably not Linux.
 *
 * Two of them are worth proving and neither is provable by reading the code.
 *
 * The first is shell resolution. A GUI app started from a .desktop entry or an
 * AppImage inherits a session environment that usually has no SHELL in it, and
 * the old fallback was /bin/zsh — which macOS always has and Raspberry Pi OS,
 * Debian and Fedora do not. Every pane would have failed to spawn on exactly
 * the machines most likely to launch from an icon. What matters is not which
 * path comes back but that it is one that exists, so that is what is asserted,
 * and it is assertable anywhere.
 *
 * The second is packaging. A Linux build that quietly carries macOS binaries,
 * or omits an architecture, fails long after the build that caused it.
 *
 *   node scripts/check-linux.mjs
 */

import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-linux-'))

let pass = 0
const failures = []

function check(name, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

/* ---- bundle the module under test ------------------------------------ */

const outfile = path.join(tmp, 'login-shell.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/login-shell.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { loginShell, loginShellArgs } = await import(outfile)

/* ---- shell resolution ------------------------------------------------- */

console.log('\nlogin shell')

const savedShell = process.env.SHELL

// The invariant the Pi case turns on: whatever comes back has to be runnable.
// A path that does not exist is the bug this replaced.
function resolvesToSomethingReal(label) {
  const got = loginShell()
  check(label, typeof got === 'string' && got !== '' && fs.existsSync(got), `got ${got}`)
  return got
}

process.env.SHELL = savedShell
resolvesToSomethingReal('resolves to a shell that exists, with the environment as it is')

// A GUI session with no SHELL at all — a .desktop launch, an AppImage, a Dock
// icon. This is the case the old code got wrong.
delete process.env.SHELL
const noEnv = resolvesToSomethingReal('resolves with no SHELL in the environment')
check(
  'the no-SHELL answer is not a hardcoded /bin/zsh guess',
  noEnv !== '/bin/zsh' || fs.existsSync('/bin/zsh'),
  `got ${noEnv}`
)

// An inherited SHELL naming something uninstalled, which is what a user who
// switched shells, or a copied dotfile, can leave behind.
process.env.SHELL = path.join(tmp, 'definitely-not-installed')
const bogus = resolvesToSomethingReal('ignores a SHELL that points at nothing')
check('does not return the missing path', bogus !== process.env.SHELL, `got ${bogus}`)

// passwd entries for service accounts name these; handing one to a pane gives
// a terminal that closes the instant it opens.
const nologin = path.join(tmp, 'nologin')
fs.writeFileSync(nologin, '#!/bin/sh\nexit 1\n')
fs.chmodSync(nologin, 0o755)
process.env.SHELL = nologin
const refused = resolvesToSomethingReal('refuses a nologin shell even though it exists')
check('does not return the nologin path', refused !== nologin, `got ${refused}`)

if (savedShell === undefined) delete process.env.SHELL
else process.env.SHELL = savedShell

/* ---- login arguments --------------------------------------------------- */

console.log('\nlogin arguments')

// -l is what sources the profile that puts `claude` on PATH.
for (const shell of ['/bin/bash', '/bin/zsh', '/bin/sh', '/bin/dash', '/usr/bin/fish']) {
  check(`${shell} is run as a login shell`, loginShellArgs(shell).includes('-l'))
}
// Passing -l to something that does not understand it turns a working pane
// into an immediate exit, so anything unrecognised gets nothing.
check('an unrecognised shell is given no flags', loginShellArgs('/usr/bin/nu').length === 0)

/* ---- no stale /bin/zsh fallbacks remain -------------------------------- */

console.log('\nsources')

const offenders = []
for (const dir of ['src/main', 'src/shared']) {
  const base = path.join(root, dir)
  if (!fs.existsSync(base)) continue
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) {
        const text = fs.readFileSync(full, 'utf8')
        // The pattern that broke Linux: reach for SHELL, fall back to a macOS path.
        if (/process\.env\.SHELL\s*\|\|\s*['"]\/bin\/(zsh|bash)['"]/.test(text)) {
          offenders.push(path.relative(root, full))
        }
      }
    }
  }
  walk(base)
}
check(
  'no main-process file still falls back to a hardcoded shell',
  offenders.length === 0,
  offenders.join(', ')
)

/* ---- packaging --------------------------------------------------------- */

console.log('\npackaging')

const cfg = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
const linux = cfg.linux ?? {}
const targets = Array.isArray(linux.target) ? linux.target : []
const named = targets.map((t) => (typeof t === 'string' ? t : t.target))

check('an AppImage is built — the artifact that runs on an unplanned distro', named.includes('AppImage'))
check('a .deb is built — Debian, Ubuntu and Raspberry Pi OS', named.includes('deb'))
check('an .rpm is built — Fedora and openSUSE', named.includes('rpm'))

/*
 * No target may pin its own architecture.
 *
 * A target that names `arch:` overrides `--arm64` / `--x64` on the command
 * line, so electron-builder builds every listed architecture whatever you
 * asked for. On Linux that is not a slow build but a broken one: node-pty is
 * compiled for the host only, so the other architecture is packaged around a
 * binary it cannot load — and the rebuild attempt that precedes it deletes the
 * good binary on its way to failing, so the *next* build ships no terminal at
 * all. Caught by actually building on Debian; nothing about the config looked
 * wrong.
 */
const pinned = targets.filter((t) => typeof t !== 'string' && t.arch)
check(
  'no Linux target pins its own arch — the command line has to decide',
  pinned.length === 0,
  pinned.map((t) => t.target).join(', ')
)

// dpkg will not build a package without a maintainer, and electron-builder
// reports it late enough that the AppImage is already on disk and the build
// looks like it worked.
check('a deb maintainer is set', typeof linux.maintainer === 'string' && /<.+@.+>/.test(linux.maintainer))
// desktopName is package.json metadata, not a linux build option. Putting it
// under `linux:` fails schema validation before a single file is written.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
check('a desktopName is set, in package.json where it belongs', pkg.desktopName === 'eaon-ade.desktop')
check('it is not in the linux config, where it is not a valid key', linux.desktopName === undefined)
check('a homepage is set — deb will not build without one', typeof pkg.homepage === 'string')

check('the Linux binary has no space in its name', linux.executableName === 'eaon-ade')

/*
 * And that the packaging script strips the space from productName too. The
 * install directory is /opt/<productName>, and Chromium's setuid sandbox
 * helper splits its own path on whitespace — so a space there means the app
 * does not start at all on any machine that needs that sandbox.
 */
const distScript = fs.readFileSync(path.join(root, 'scripts/dist-linux.mjs'), 'utf8')
check(
  'the packaging script installs to a path with no space in it',
  /-c\.productName=eaon-ade/.test(distScript)
)
check(
  'and puts the readable name back in the launcher entry',
  linux.desktop?.entry?.Name === 'Eaon ADE'
)
check(
  'the desktop entry is named to match the window class',
  linux.syncDesktopName === true && linux.desktop?.entry?.StartupWMClass === 'eaon-ade'
)

// Every platform's section drops the other platforms' native binaries. A
// Linux package that ships Mach-O .node files is both dead weight and a
// loader that can pick the wrong one.
const excludes = (linux.files ?? []).join('\n')
check('darwin ONNX binaries are excluded', /onnxruntime-node[^\n]*darwin/.test(excludes))
check('other platforms’ node-pty prebuilds are excluded', /node-pty\/prebuilds/.test(excludes))
check('darwin and win32 sharp packages are excluded', /sharp-\{darwin,win32\}/.test(excludes))

// asarUnpack has to cover node-pty or the compiled pty.node ends up inside the
// archive, where dlopen cannot reach it.
check(
  'node-pty is unpacked from the asar archive',
  (cfg.asarUnpack ?? []).some((p) => p.includes('node-pty'))
)


/* ---- memory readings --------------------------------------------------- */

console.log('\nmemory')

/*
 * The memory reader is a separate piece of work that is not committed yet, so
 * these checks only run where it exists. When it lands they start running on
 * their own; until then a clean checkout is not failed for its absence.
 */
const memorySrc = path.join(root, 'src/main/memory.ts')
if (!fs.existsSync(memorySrc)) {
  console.log('  --   skipped: src/main/memory.ts is not present in this checkout')
} else {
const memOut = path.join(tmp, 'memory.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/memory.ts')],
  outfile: memOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  logLevel: 'silent'
})
const { parseMemInfo, pressureFor } = await import(memOut)

/*
 * A Raspberry Pi 5 with 8 GB, desktop up, a few agents running. MemFree is
 * 197 MB because Linux has spent the rest on page cache — which is healthy,
 * not a shortage. MemAvailable says there are almost 6 GB to be had.
 */
const pi = [
  'MemTotal:        8244148 kB',
  'MemFree:          201584 kB',
  'MemAvailable:    6120448 kB',
  'Buffers:          123456 kB',
  'Cached:          5800000 kB',
  'SwapTotal:        204796 kB',
  'SwapFree:         204796 kB'
].join('\n')

const read = parseMemInfo(pi)
check('reads MemAvailable, not MemFree', read.freeMb === 5977, `got ${read.freeMb} MB`)
check('reads swap', read.swapFreeMb === 200 && read.swapTotalMb === 200,
  `got ${read.swapFreeMb}/${read.swapTotalMb} MB`)

// The regression itself: os.freemem() on Linux returns MemFree, and MemFree
// on this healthy Pi is below the critical threshold.
check(
  'a healthy Pi is not called critical',
  pressureFor(read.freeMb, read.swapFreeMb, read.swapTotalMb) === 'ok'
)
check(
  'and MemFree alone would have called it critical — which is the bug',
  pressureFor(Math.round(201584 / 1024), read.swapFreeMb, read.swapTotalMb) === 'critical'
)

// A Pi genuinely out of room still has to be caught, or the OOM killer takes
// an agent mid-task instead.
const squeezed = parseMemInfo(
  ['MemTotal: 4028000 kB', 'MemFree: 48000 kB', 'MemAvailable: 210000 kB',
   'SwapTotal: 102396 kB', 'SwapFree: 51200 kB'].join('\n')
)
check(
  'a Pi that really is out of memory is still refused',
  pressureFor(squeezed.freeMb, squeezed.swapFreeMb, squeezed.swapTotalMb) === 'critical',
  `${squeezed.freeMb} MB free, ${squeezed.swapFreeMb} MB swap`
)

// Kernels before 3.14 have no MemAvailable line at all.
const ancient = parseMemInfo(['MemTotal: 1000000 kB', 'MemFree: 512000 kB'].join('\n'))
check('falls back to MemFree on a kernel without MemAvailable', ancient.freeMb === 500,
  `got ${ancient.freeMb} MB`)
}

/* ---- report ------------------------------------------------------------ */

fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
