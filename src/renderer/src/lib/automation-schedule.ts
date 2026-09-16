import { useEffect } from 'react'
import { dueAutomations } from '@shared/automations'
import { useStore } from '../store/useStore'

/** How often the clock is consulted. A minute's granularity is the schedule's. */
const TICK_MS = 60_000

/**
 * Runs `daily` automations when their time comes round.
 *
 * One interval for all of them rather than a timer each: a timer per
 * automation would have to be rebuilt whenever one was edited, and a machine
 * that sleeps through a `setTimeout` fires it late anyway. Asking "what is due
 * now?" once a minute is both simpler and correct across sleep.
 *
 * `watchingSince` is captured when the interval starts, and is what stops a
 * laptop opened in the evening from firing every automation it missed that
 * day. See `isDailyDue` for the rule.
 */
export function useAutomationSchedule(): void {
  useEffect(() => {
    const watchingSince = Date.now()

    const tick = (): void => {
      const s = useStore.getState()
      if (!s.ready) return
      // Snapshotted before any run, so the list cannot change underneath the
      // loop as each run writes its lastRunAt back.
      for (const a of dueAutomations(s.automations, Date.now(), watchingSince)) {
        useStore.getState().runAutomation(a)
      }
    }

    const id = window.setInterval(tick, TICK_MS)
    return () => window.clearInterval(id)
  }, [])
}
