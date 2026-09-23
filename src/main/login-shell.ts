/**
 * Which shell this user's panes should run.
 *
 * `$SHELL` is the right answer whenever it is set, and from a terminal it
 * always is. From a GUI launcher it frequently is not: an app started from a
 * .desktop entry, an AppImage, a Dock icon or a Start menu shortcut inherits
 * the session's environment, and most Linux desktop sessions do not put SHELL
 * in it.
 *
 * That was survivable on macOS, where the old fallback — `/bin/zsh` — is part
 * of the OS and always present. On Linux it is not: Raspberry Pi OS, Debian,
 * Fedora and Alpine all ship without zsh unless somebody installs it. So the
 * fallback resolved to a path that does not exist, every pane failed to spawn,
 * and the app looked like it had no terminal at all — on precisely the
 * machines most likely to be launched from a desktop icon.
 *
 * `os.userInfo()` reads the passwd entry, which is where a login shell
 * actually lives. It needs no environment and is correct even when the app was
 * started by the window manager.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Shells that exist to refuse a login. A passwd entry can name one. */
const NON_INTERACTIVE = new Set(['nologin', 'false', 'sync', 'shutdown', 'halt'])

/** Tried in order when neither the environment nor passwd gives a usable answer. */
const FALLBACKS = ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/zsh']

function usable(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false
  if (NON_INTERACTIVE.has(path.basename(candidate))) return false
  try {
    return fs.existsSync(candidate)
  } catch {
    // An unreadable path is not one to hand a pane.
    return false
  }
}

/**
 * The user's login shell, guaranteed to be a path that exists.
 *
 * Windows has no equivalent and callers there want their own answer, so this
 * is POSIX-only; `PtyManager.defaultShell` keeps the PowerShell selection.
 */
export function loginShell(): string {
  if (usable(process.env.SHELL)) return process.env.SHELL as string

  try {
    const fromPasswd = os.userInfo().shell
    if (usable(fromPasswd)) return fromPasswd as string
  } catch {
    // userInfo throws when there is no passwd entry for the uid, which happens
    // inside some containers. The fallback list still applies.
  }

  for (const candidate of FALLBACKS) {
    if (usable(candidate)) return candidate
  }

  // Nothing on the list exists, which should be impossible on a POSIX system.
  // Returning the traditional path at least produces a legible spawn error
  // rather than an empty string.
  return '/bin/sh'
}

/**
 * The arguments that make `shell` a login shell.
 *
 * A login shell is what sources the user's profile, and the profile is where
 * the PATH that has `claude` on it comes from. Only shells known to accept
 * `-l` get it: passing it to something that does not understand it turns a
 * working pane into an immediate exit.
 */
export function loginShellArgs(shell: string): string[] {
  const name = path.basename(shell).toLowerCase()
  return ['bash', 'zsh', 'fish', 'sh', 'dash', 'ash', 'ksh'].includes(name) ? ['-l'] : []
}
