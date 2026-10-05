/** localStorage can throw (private mode, blocked storage): every access is guarded. */
export function readNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}
export function writeValue(key: string, value: string | number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}
