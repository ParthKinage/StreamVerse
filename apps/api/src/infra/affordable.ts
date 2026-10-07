import { InsufficientGas } from '@tesor_gp/blockchain';

/**
 * Sends `items` in one transaction. When the relayer cannot afford the gas for all of them, sends the oldest half,
 * then a quarter, down to a single item, so a lightly funded relayer still makes progress instead of failing the
 * whole batch. The items not sent stay waiting for the next run. Throws InsufficientGas when not even one fits.
 */
export async function sendAffordable<T, R>(items: T[], send: (batch: T[]) => Promise<R>): Promise<{ sent: T[]; result: R }> {
  let n = items.length;
  for (;;) {
    const batch = items.slice(0, n);
    try {
      return { sent: batch, result: await send(batch) };
    } catch (err) {
      if (!(err instanceof InsufficientGas) || n <= 1) throw err;
      n = Math.ceil(n / 2);
    }
  }
}
