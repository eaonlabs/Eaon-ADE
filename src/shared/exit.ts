/**
 * What ended a pane's shell, in a sentence somebody can act on.
 *
 * This is the whole of the "session unexpectedly quit" problem. When the
 * kernel runs out of memory it picks a process and sends it SIGKILL; node-pty
 * reports that as `{ exitCode: 0, signal: 9 }`. Exit code zero. So the app read
 * it as a clean exit, said nothing at all, and the pane simply went blank —
 * which is exactly what people described: sessions ending with nobody touching
 * anything and no reason given anywhere.
 *
 * The signal is what distinguishes those cases. `requested` is what keeps the
 * distinction useful: the main process sets it whenever the exit went through
 * `kill()`, which is every teardown the app itself performs, so a session
 * somebody deliberately stopped is silent and only an exit nobody asked for is
 * reported. Measured, not assumed — a shell stopped through `kill()` on macOS
 * comes back as exit code 1, so without `requested` every stop raised an error
 * about a session the person had just closed on purpose.
 */

/** Signals that mean the process itself came apart. */
const FAULTS: Record<number, string> = {
  4: 'an illegal instruction',
  6: 'an abort',
  8: 'an arithmetic fault',
  11: 'a segmentation fault'
}

/**
 * A sentence for the pane, or null when the exit needs no explanation.
 *
 * `signal` is node-pty's, so 0 or undefined means the process exited of its own
 * accord — a shell that was told to exit, or an agent that finished.
 * `requested` means the app asked for this exit, which is never news.
 */
export function exitReason(code: number, signal?: number, requested?: boolean): string | null {
  if (requested) return null
  if (!signal) return code === 0 ? null : `The shell stopped with code ${code}.`
  if (signal === 9) return 'The system stopped this agent to reclaim memory.'
  const fault = FAULTS[signal]
  if (fault) return `This agent stopped on ${fault}.`
  return `Something outside the app stopped this agent (signal ${signal}).`
}

/** True when the kernel, not the app and not the agent, ended it. */
export function killedByOs(signal?: number, requested?: boolean): boolean {
  return signal === 9 && !requested
}
