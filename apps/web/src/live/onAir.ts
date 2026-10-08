import { useSyncExternalStore } from 'react';

/**
 * Whether this page is sending a live stream right now. Kept apart from the live session (which carries the video
 * encoder library) so the top bar and Studio can show it without loading that library on every page.
 */
let onAir = false;
const listeners = new Set<() => void>();

export function setOnAir(value: boolean): void {
  if (value === onAir) return;
  onAir = value;
  for (const fn of listeners) fn();
}

export function isOnAirNow(): boolean {
  return onAir;
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useOnAir(): boolean {
  return useSyncExternalStore(subscribe, isOnAirNow, isOnAirNow);
}
