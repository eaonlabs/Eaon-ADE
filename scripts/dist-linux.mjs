/**
 * Packages the Linux builds — on Linux, which is the only place they can be
 * packaged correctly.
 *
 * The Windows story has a happy ending because node-pty publishes prebuilt
 * binaries for win32-x64 and win32-arm64: a macOS checkout can copy the right
 * one in and never compile anything. There is no such ending here. node-pty
 * publishes prebuilds for darwin and win32 and *none at all* for Linux; its
 * install script is `node scripts/prebuild.js || node-gyp rebuild`, and on
 * Linux it is always the second half that runs.
 *
 * So a Linux package built from macOS contains no pty binary. The failure is
 * quiet in the way that matters: the AppImage builds, it runs, the window
 * opens, and then not one pane can start, because node-pty looks in
 * build/Release, build/Debug and prebuilds/linux-<arch> and finds nothing it
 * can load. Shipping a terminal that cannot open a terminal is worse than
 * shipping nothing, which is the same judgement `dist-win.mjs` makes about
 * Windows ia32.
 *
 * Run this on a Linux machine, or let .github/workflows/linux.yml run it on
 * one. On a Raspberry Pi it also just works — `npm install` there compiles
 * node-pty for the Pi and fetches the Pi's own sharp.
 *
 *   npm run dist:linux
 */
import { execFileSync } from 'node:child_process'
import { arch as hostArch, platform } from 'node:os'

if (platform() !== 'linux') {
  console.error(
    `\nLinux packages cannot be built on ${platform()}.\n\n` +
      `node-pty publishes no Linux prebuild, and node-gyp cannot compile one for\n` +
      `another platform. A package built here would install, open a window, and\n` +
      `then fail to start a single terminal pane.\n\n` +
      `Build it on Linux instead:\n` +
      `  • push a v* tag and let .github/workflows/linux.yml build and test it\n` +
      `  • or run this on any Linux box, including the Raspberry Pi itself\n`
  )
  process.exit(1)
}

/*
 * Cross-*architecture* is fine once we are on Linux for AppImage and tar.gz —
 * electron-builder downloads the Electron runtime for the target arch — but
 * node-pty is still compiled for the host. Building arm64 on an x64 machine
 * therefore has exactly the problem above. So each architecture is built on a
 * machine of that architecture, and this script packages only the host's.
 */
const target = process.argv.includes('--all') ? null : hostArch()

/*
 * AppImage is x86-64 only.
 *
 * electron-builder's bundled AppImage runtime for arm64 links against the
 * unversioned `libz.so`, which is in zlib1g-dev and on no ordinary desktop, so
 * the image dies with "error while loading shared libraries: libz.so" before
 * the app is reached. The x86-64 runtime links libz.so.1 and works. Rather
 * than ship an artifact that cannot start, arm64 builds the other three —
 * and on a Raspberry Pi the .deb was the right answer anyway.
 */
const TARGETS = ['AppImage', 'deb', 'rpm', 'tar.gz']
const targets = target === 'arm64' ? TARGETS.filter((t) => t !== 'AppImage') : TARGETS

/*
 * productName is overridden for Linux only, and this is not cosmetic.
 *
 * electron-builder installs to /opt/<productName>, which for "Eaon ADE" is a
 * path with a space in it. Chromium's setuid sandbox helper splits its own
 * path on whitespace when it launches, so on any machine that needs that
 * sandbox — one with unprivileged user namespaces switched off — the zygote
 * dies with:
 *
 *   LaunchProcess: failed to execvp: /opt/Eaon
 *   FATAL .. zygote_host_impl_linux.cc Check failed
 *
 * and the app never opens a window. Verified on Debian 12 with
 * kernel.unprivileged_userns_clone=0.
 *
 * So Linux packages install to /opt/eaon-ade. The launcher entry puts the
 * readable name back (linux.desktop.entry.Name), the window title comes from
 * app.setName() at runtime, and the settings directory is unchanged — none of
 * them go through this path.
 */
/*
 * --publish never, always.
 *
 * electron-builder's default is `onTagOrDraft`, so the moment this runs on a
 * tag it tries to upload to GitHub and fails the build with "GitHub Personal
 * Access Token is not set" — after every artifact has already been written
 * successfully. Packaging and publishing are separate acts here: the release
 * workflow uploads with `gh release upload`, deliberately and only when asked.
 */
const args = [
  'electron-builder',
  '--linux',
  ...targets,
  '-c.productName=eaon-ade',
  '--publish',
  'never'
]
if (target) args.push(`--${target}`)

console.log(
  target
    ? `Packaging for Linux ${target} (this machine's architecture): ${targets.join(', ')}.`
    : 'Packaging for every configured Linux architecture — --all was passed.\n' +
        'Only do this when node-pty has been built for each of them.'
)
if (target === 'arm64') {
  console.log('Skipping AppImage: its arm64 runtime cannot start on an ordinary system.')
}

if (target && !['x64', 'arm64'].includes(target)) {
  console.log(
    `\nNote: ${target} is not one of the architectures electron-builder.yml lists.\n` +
      `On 32-bit ARM the app runs but dictation does not — ONNX Runtime ships no\n` +
      `32-bit build — and you will need to add the arch to the linux targets.\n`
  )
}

try {
  execFileSync('npx', args, { stdio: 'inherit' })
} catch {
  process.exit(1)
}
