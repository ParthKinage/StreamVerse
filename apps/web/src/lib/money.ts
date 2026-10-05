import { parseSTRM } from '@tesor_gp/shared';

/** Parses a typed amount ("250", "99.50") into wei. Returns an error message instead of throwing. */
export function parseMoneyInput(text: string): { wei: bigint } | { error: string } {
  const t = text.trim();
  if (!t) return { error: 'Enter an amount' };
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return { error: 'Enter a valid amount, for example 250 or 99.50' };
  const wei = parseSTRM(t);
  if (wei <= 0n) return { error: 'Amount must be more than zero' };
  return { wei };
}
