/**
 * An automation: a saved prompt, plus what makes it run.
 *
 * Running one is deliberately not a new mechanism. It opens a workspace the
 * same way the setup wizard does, with one pane and the prompt attached, and
 * the existing `pendingPrompts` delivery types it into the agent once the shell
 * is up. So an automation is a *remembered* launch rather than a second way of
 * starting agents, and anything that improves launching improves it too.
 *
 * Kept in `src/shared/` because the persisted state crosses the preload bridge
 * and both sides need the shape.
 */

/**
 * What starts an automation.
 *
 * A discriminated union rather than a bare string so the time of day has
 * somewhere to live that only exists when it means something — a `daily`
 * automation always has an `at`, and the other two cannot accidentally carry a
 * stale one.
 */
export type AutomationTrigger =
  | { kind: 'manual' }
  | { kind: 'onOpen' }
  /** `at` is "HH:MM", 24-hour, in whatever timezone the machine is in. */
  | { kind: 'daily'; at: string }

export type TriggerKind = AutomationTrigger['kind']

export interface Automation {
  id: string
  name: string
  prompt: string
  /** An AGENTS id. Never 'shell': a prompt with nothing to read it does nothing. */
  agentId: string
  cwd: string
  trigger: AutomationTrigger
  /** Epoch ms of the last run, or null if it has never been run. */
  lastRunAt: number | null
}

export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  manual: 'Manual',
  onOpen: 'When the folder opens',
  daily: 'Daily'
}

/** One line describing when this runs, for the row. */
export function triggerLabel(trigger: AutomationTrigger): string {
  return trigger.kind === 'daily'
    ? `Daily at ${trigger.at}`
    : TRIGGER_LABEL[trigger.kind]
}

/** "HH:MM" on a 24-hour clock, which is what `<input type="time">` produces. */
export function isValidTime(at: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(at)
}

/**
 * Whether an automation is complete enough to save.
 *
 * A name is what the row is identified by, a prompt is the whole point, and a
 * folder is where it would run — none of the three has a sensible default.
 */
export function isRunnable(a: Automation): boolean {
  if (!a.name.trim() || !a.prompt.trim() || !a.cwd.trim()) return false
  if (a.agentId === 'shell') return false
  return a.trigger.kind !== 'daily' || isValidTime(a.trigger.at)
}

/* ── when a daily automation is due ──────────────────────────────────────── */

/**
 * The instant a `daily` automation is meant to run on a given local day.
 *
 * Built out of date *parts* rather than by adding milliseconds to midnight,
 * which is the whole reason this is a function. A local day is not always
 * 24 hours: on the spring-forward date it is 23, so `midnight + 9h` lands an
 * hour off, and on a fall-back date it is 25. Handing the parts to `Date` lets
 * the platform's own timezone rules place the instant.
 *
 * On a spring-forward day a time inside the skipped hour does not exist —
 * 02:30 where the clock jumps 02:00 → 03:00. `Date` normalises that forward to
 * 03:30, so the automation runs once, an hour later by the wall clock, rather
 * than being silently skipped for the day.
 */
export function scheduledOn(day: Date, at: string): Date | null {
  if (!isValidTime(at)) return null
  const [hh, mm] = at.split(':').map(Number)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0)
}

/** Same calendar day in local time — which is the grain "already ran today" uses. */
export function isSameLocalDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  )
}

/**
 * Whether a `daily` automation should fire now.
 *
 * Three things have to hold, and the middle one is the one worth explaining.
 *
 * 1. Its time today has passed.
 * 2. That time fell *while the app was watching*. Without this, opening a
 *    laptop at six in the evening would fire every automation scheduled
 *    earlier that day, all at once — five agents nobody asked for. A missed
 *    run stays missed.
 * 3. It has not already run today. Day-grain deliberately: a manual Run counts
 *    as the day's run, so pressing Run at 08:00 means the 09:00 schedule stays
 *    quiet rather than opening a second pane doing the same work.
 *
 * `watchingSince` is when the scheduler started, not when the app did, so it
 * survives the scheduler being torn down and rebuilt.
 */
export function isDailyDue(
  automation: Automation,
  now: number,
  watchingSince: number
): boolean {
  const trigger = automation.trigger
  if (trigger.kind !== 'daily') return false
  if (!isRunnable(automation)) return false

  const scheduled = scheduledOn(new Date(now), trigger.at)
  if (!scheduled) return false

  const at = scheduled.getTime()
  if (now < at) return false
  if (at < watchingSince) return false
  if (automation.lastRunAt !== null && isSameLocalDay(automation.lastRunAt, now)) return false
  return true
}

/** Every automation due right now, in list order. */
export function dueAutomations(
  automations: Automation[],
  now: number,
  watchingSince: number
): Automation[] {
  return automations.filter((a) => isDailyDue(a, now, watchingSince))
}

/** True when this automation should run as its folder's workspace is opened. */
export function firesOnOpen(automation: Automation, cwd: string): boolean {
  return (
    automation.trigger.kind === 'onOpen' && automation.cwd === cwd && isRunnable(automation)
  )
}
