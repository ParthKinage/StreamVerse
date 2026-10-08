import { formatSTRM, formatSTRMFull } from '@tesor_gp/shared';

/** Parses a wei decimal string from the API; returns 0n for anything that is not a non-negative integer. */
export function toBig(value: string | null | undefined): bigint {
  if (!value || !/^\d+$/.test(value)) return 0n;
  return BigInt(value);
}

/** STRM with up to 4 decimals. The full-precision value is available via `strmTitle` (for hover). */
export function strm(wei: string | bigint | null | undefined): string {
  return formatSTRM(typeof wei === 'bigint' ? wei : toBig(wei), 4);
}
export function strmTitle(wei: string | bigint | null | undefined): string {
  return `${formatSTRMFull(typeof wei === 'bigint' ? wei : toBig(wei))} STRM`;
}

/**
 * Display currency. The API reports `paymentsMode`; in "bank" mode amounts read as ₹12.50, in "chain" mode as "12.5 STRM".
 * Amounts are always wei-style integers underneath; only the label changes.
 */
export interface MoneyFormat {
  mode: 'bank' | 'chain';
  symbol: string;
  code: string;
}
let moneyFormat: MoneyFormat = { mode: 'chain', symbol: '', code: 'STRM' };
export function setMoneyFormat(f: MoneyFormat): void {
  moneyFormat = f;
}
export function getMoneyFormat(): MoneyFormat {
  return moneyFormat;
}
export function isBankMode(): boolean {
  return moneyFormat.mode === 'bank';
}
/** "₹12.50" in bank mode (2 to 4 decimals), "12.5 STRM" in chain mode. */
export function money(wei: string | bigint | null | undefined): string {
  if (moneyFormat.mode === 'chain') return `${strm(wei)} STRM`;
  const n = strm(wei);
  const [int = '0', frac = ''] = n.split('.');
  return `${moneyFormat.symbol}${int}.${frac.padEnd(2, '0')}`;
}
export function moneyTitle(wei: string | bigint | null | undefined): string {
  if (moneyFormat.mode === 'chain') return strmTitle(wei);
  return `${moneyFormat.symbol}${formatSTRMFull(typeof wei === 'bigint' ? wei : toBig(wei))}`;
}
/** Unit for column headings and input labels: "STRM" or "INR (₹)". */
export function moneyUnit(): string {
  return moneyFormat.mode === 'chain' ? 'STRM' : `${moneyFormat.code} (${moneyFormat.symbol})`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'now';
  return formatDuration(Math.ceil(msRemaining / 1000));
}

export function shortAddress(address: string | null | undefined): string {
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`;
  return `${n} view${n === 1 ? '' : 's'}`;
}

/** Price of a whole video, or "Free". */
export function priceLabel(wei: string): string {
  return toBig(wei) === 0n ? 'Free' : money(wei);
}

/** A creator's rate, e.g. "2 STRM/min", or "Free". Viewers pay it per second they are sent. */
export function rateLabel(ratePerMinuteWei: string): string {
  return toBig(ratePerMinuteWei) === 0n ? 'Free' : `${money(ratePerMinuteWei)}/min`;
}

/** What a video costs: one price for permanent access (live streams and their recordings) or a rate per minute. */
export function costLabel(video: { ratePerMinuteWei: string; accessPriceWei?: string | null | undefined }): string {
  if (video.accessPriceWei !== null && video.accessPriceWei !== undefined) {
    return toBig(video.accessPriceWei) === 0n ? 'Free' : `${money(video.accessPriceWei)} once`;
  }
  return rateLabel(video.ratePerMinuteWei);
}
