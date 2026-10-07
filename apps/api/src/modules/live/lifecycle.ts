import type { LiveStatus } from '@tesor_gp/shared';
import { AppError } from '../../middleware/errors';

/**
 * The only allowed moves of a live stream (spec E3): CREATED -> STARTING -> LIVE -> ENDING -> ENDED, and any state that
 * has not finished may go to FAILED. Staying in STARTING or LIVE is allowed: that is the creator reconnecting.
 */
const NEXT: Record<LiveStatus, readonly LiveStatus[]> = {
  CREATED: ['STARTING', 'FAILED'],
  STARTING: ['STARTING', 'LIVE', 'ENDING', 'FAILED'],
  LIVE: ['LIVE', 'ENDING', 'FAILED'],
  ENDING: ['ENDED', 'FAILED'],
  ENDED: [],
  FAILED: [],
};

export function canTransition(from: LiveStatus, to: LiveStatus): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: LiveStatus, to: LiveStatus): void {
  if (!canTransition(from, to)) throw new AppError(409, 'INVALID_TRANSITION', `A stream that is ${from.toLowerCase()} cannot become ${to.toLowerCase()}`, { from, to });
}

/** States in which the creator may still send pieces. */
export const SENDING_STATES: readonly LiveStatus[] = ['STARTING', 'LIVE'];
/** States that are over for good. */
export const FINISHED_STATES: readonly LiveStatus[] = ['ENDED', 'FAILED'];
