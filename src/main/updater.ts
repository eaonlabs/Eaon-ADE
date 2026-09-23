import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import electronUpdater from 'electron-updater'
import { IDLE_UPDATE_STATE, notesToText, type UpdateState } from '../shared/update'

// electron-updater is CommonJS; the named export is not reachable via ESM
// interop in the bundled main process.
const { autoUpdater } = electronUpdater

/** Re-check this often while the app stays open. */
const POLL_MS = 6 * 60 * 60 * 1000
/** Wait for the window to settle before the first check. */
const FIRST_CHECK_MS = 8_000

type Sender = (channel: string, payload: unknown) => void

/**
 * Owns the update lifecycle.
 *
 * Updates download in the background and are applied on the next restart, so
 * the interruption is one banner and one click rather than a modal in front of
 * running agents. Nothing is ever installed underneath you — `quitAndInstall`
 * only happens when you ask for it.
 */
export class Updater {
  private state: UpdateState = { ...IDLE_UPDATE_STATE }
  private send: Sender = () => {}
  private timer: NodeJS.Timeout | null = null
  private wired = false

  /** True when this build can actually receive updates. */
  private supported(): boolean {
    /*
     * On Linux only an AppImage can replace itself. A .deb or .rpm belongs to
     * the system package manager, and an app that reached in and swapped its
     * own files would be fighting dpkg for ownership of them — so those builds
     * are updated by `apt upgrade`, the way everything else on the machine is.
     *
     * The AppImage runtime is what sets APPIMAGE; nothing else does. Without
     * this, electron-updater quietly declines to act and the panel sits at
     * "checking" forever rather than saying it is not its job.
     */
    if (process.platform === 'linux' && app.isPackaged && !process.env.APPIMAGE) {
      this.state.unsupportedReason =
        'This copy was installed by your package manager — update it with that.'
      return false
    }

    // A packaged build carries app-update.yml. In development the same file can
    // be supplied by hand as dev-app-update.yml, which is how this gets tested
    // without cutting a real release.
    if (app.isPackaged) return true
    return existsSync(path.join(app.getAppPath(), 'dev-app-update.yml'))
  }

  setSender(sender: Sender): void {
    this.send = sender
  }

  current(): UpdateState {
    return this.state
  }

  private patch(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next }
    try {
      this.send('update:state', this.state)
    } catch {
      /* the window can go away mid-download */
    }
  }

  start(): void {
    if (!this.supported()) {
      this.patch({ phase: 'unsupported' })
      return
    }

    this.wire()

    // Fetch in the background; the user is told once it is ready to install.
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    // Without a packaged app there is no real version to compare against.
    if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true

    setTimeout(() => void this.check(), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), POLL_MS)
  }

  private wire(): void {
    if (this.wired) return
    this.wired = true

    autoUpdater.on('checking-for-update', () => this.patch({ phase: 'checking', error: null }))

    autoUpdater.on('update-not-available', () => {
      this.patch({
        phase: 'current',
        version: null,
        notes: null,
        lastCheckedAt: Date.now()
      })
    })

    autoUpdater.on('update-available', (info) => {
      this.patch({
        phase: 'downloading',
        version: info.version,
        notes: notesToText(typeof info.releaseNotes === 'string' ? info.releaseNotes : null),
        releaseDate: info.releaseDate ?? null,
        percent: 0,
        transferred: 0,
        total: 0,
        error: null,
        lastCheckedAt: Date.now()
      })
    })

    autoUpdater.on('download-progress', (p) => {
      this.patch({
        phase: 'downloading',
        percent: Math.max(0, Math.min(100, p.percent ?? 0)),
        bytesPerSecond: p.bytesPerSecond ?? 0,
        transferred: p.transferred ?? 0,
        total: p.total ?? 0
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.patch({
        phase: 'ready',
        version: info.version,
        notes:
          notesToText(typeof info.releaseNotes === 'string' ? info.releaseNotes : null) ??
          this.state.notes,
        percent: 100,
        lastCheckedAt: Date.now()
      })
    })

    autoUpdater.on('error', (err) => this.fail(err))
  }

  /**
   * Turns a failure into a phase.
   *
   * An unreachable or empty feed is the normal state — before the first release
   * is published, on a flaky network, behind a captive portal — and none of that
   * is worth showing someone a stack trace over. Those read as "nothing new".
   * Anything genuinely unexpected still surfaces.
   */
  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const benign =
      /404|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|net::ERR/i.test(message) ||
      /no published versions|cannot find .*\.yml|unable to find latest version/i.test(message)
    this.patch({
      phase: benign ? 'current' : 'error',
      error: benign ? null : message,
      lastCheckedAt: Date.now()
    })
  }

  /** Manual check from Settings. Resolves once the request is dispatched. */
  async check(): Promise<UpdateState> {
    if (!this.supported()) {
      this.patch({ phase: 'unsupported' })
      return this.state
    }
    // Nothing to look for once a build is already staged.
    if (this.state.phase === 'ready' || this.state.phase === 'downloading') return this.state
    this.wire()
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // checkForUpdates rejects as well as emitting 'error', and a 404 from an
      // empty feed arrives here. Same classification either way.
      this.fail(err)
    }
    return this.state
  }

  /** Quit and swap in the downloaded build. */
  install(): void {
    if (this.state.phase !== 'ready') return
    // Close windows first so no PTY write lands mid-swap.
    for (const win of BrowserWindow.getAllWindows()) win.removeAllListeners('close')
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
