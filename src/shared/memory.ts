/**
 * Whether there is room on this machine to start another agent.
 *
 * Shared because three sides need the same answer: the main process measures
 * it, the preload bridge declares it, and the renderer shows it.
 */

export type MemoryPressure = 'ok' | 'tight' | 'critical'

export interface MemoryHeadroom {
  freeMb: number
  swapFreeMb: number
  swapTotalMb: number
  /** How much the OS is already holding compressed to avoid swapping. */
  compressedMb: number
  pressure: MemoryPressure
  /** One line, ready to show. Empty when there is nothing to say. */
  note: string
}
