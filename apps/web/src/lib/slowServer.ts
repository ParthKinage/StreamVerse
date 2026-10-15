import { useSyncExternalStore } from 'react';

/**
 * Notices when the API is slow to answer, which on the free hosting plan means the server is waking up (about a
 * minute after 15 idle minutes). Every API request reports when it starts and ends; if any has been waiting longer
 * than SLOW_AFTER_MS, the app shows the "waking up" panel with a small game until the requests come back.
 */
export const SLOW_AFTER_MS = 3500;

let waiting = 0;
let slow = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(value: boolean): void {
  if (value === slow) return;
  slow = value;
  for (const fn of listeners) fn();
}

/** Call when a request starts; call the returned function when it ends (success or not). */
export function trackRequest(): () => void {
  waiting++;
  if (waiting === 1) timer = setTimeout(() => set(true), SLOW_AFTER_MS);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    waiting = Math.max(0, waiting - 1);
    if (waiting === 0) {
      clearTimeout(timer);
      set(false);
    }
  };
}

export function isServerSlow(): boolean {
  return slow;
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useServerSlow(): boolean {
  return useSyncExternalStore(subscribe, isServerSlow, isServerSlow);
}
