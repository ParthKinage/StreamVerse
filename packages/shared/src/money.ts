/** Money helpers. STRM has 18 decimals; all arithmetic uses bigint wei and never floats. */

export const STRM_DECIMALS = 18;
export const WEI_PER_STRM = 10n ** 18n;

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Parses a human decimal string ("1.5") into wei. Throws RangeError on invalid input or more than 18 decimals. */
export function parseSTRM(input: string): bigint {
  const value = input.trim();
  if (!DECIMAL_RE.test(value)) throw new RangeError(`Invalid STRM amount: "${input}"`);
  const [whole = '0', frac = ''] = value.split('.');
  if (frac.length > STRM_DECIMALS) throw new RangeError(`STRM supports at most ${STRM_DECIMALS} decimals`);
  return BigInt(whole) * WEI_PER_STRM + BigInt(frac.padEnd(STRM_DECIMALS, '0') || '0');
}

/** Formats wei as a decimal string with up to `maxDecimals` digits, truncating (never rounding up), trailing zeros trimmed. */
export function formatSTRM(wei: bigint, maxDecimals = 4): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_STRM;
  const frac = (abs % WEI_PER_STRM).toString().padStart(STRM_DECIMALS, '0').slice(0, Math.max(0, maxDecimals));
  const trimmed = frac.replace(/0+$/, '');
  const body = trimmed ? `${whole}.${trimmed}` : `${whole}`;
  return negative && body !== '0' ? `-${body}` : body;
}

/** Full-precision decimal string (for tooltips). */
export function formatSTRMFull(wei: bigint): string {
  return formatSTRM(wei, STRM_DECIMALS);
}

/** Cost of watching `seconds` at `ratePerMinuteWei`, floored to whole wei. */
export function costForSeconds(seconds: number | bigint, ratePerMinuteWei: bigint): bigint {
  const s = typeof seconds === 'bigint' ? seconds : BigInt(Math.max(0, Math.floor(seconds)));
  if (s < 0n || ratePerMinuteWei < 0n) throw new RangeError('seconds and rate must be non-negative');
  return (s * ratePerMinuteWei) / 60n;
}

/** Cost of `ms` milliseconds of video at `ratePerMinuteWei`, floored to whole wei (pieces of video are not whole seconds). */
export function costForMs(ms: number | bigint, ratePerMinuteWei: bigint): bigint {
  const m = typeof ms === 'bigint' ? ms : BigInt(Math.max(0, Math.round(ms)));
  if (m < 0n || ratePerMinuteWei < 0n) throw new RangeError('duration and rate must be non-negative');
  return (m * ratePerMinuteWei) / 60_000n;
}

export interface FeeSplit {
  fee: bigint;
  creator: bigint;
}

/** Splits an amount into platform fee and creator share. Matches the PaymentRouter: fee = amount * feeBps / 10000 (floor). */
export function splitFee(amount: bigint, feeBps: number): FeeSplit {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new RangeError('feeBps out of range');
  const fee = (amount * BigInt(feeBps)) / 10_000n;
  return { fee, creator: amount - fee };
}

/** Decimal(38,18) column value (string or Prisma Decimal) to wei. */
export function decimalToWei(value: { toString(): string } | string): bigint {
  const text = (typeof value === 'string' ? value : value.toString()).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError(`Invalid decimal: "${text}"`);
  const [, sign = '', whole = '0', frac = ''] = match;
  if (frac.length > STRM_DECIMALS && /[1-9]/.test(frac.slice(STRM_DECIMALS))) {
    throw new RangeError('Decimal has more than 18 significant decimals');
  }
  const wei = BigInt(whole) * WEI_PER_STRM + BigInt(frac.slice(0, STRM_DECIMALS).padEnd(STRM_DECIMALS, '0'));
  return sign === '-' ? -wei : wei;
}

/** Wei to a Decimal(38,18) compatible string, e.g. 1500000000000000000n -> "1.500000000000000000". */
export function weiToDecimal(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_STRM;
  const frac = (abs % WEI_PER_STRM).toString().padStart(STRM_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** API representation: non-negative integer wei as a string. */
export function weiToString(wei: bigint): string {
  return wei.toString();
}

export function stringToWei(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new RangeError(`Invalid wei string: "${value}"`);
  return BigInt(value);
}
