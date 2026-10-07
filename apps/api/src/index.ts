import { createApp } from './app';
import { loadEnv } from './config/env';
import { createContext } from './context';
import { startBankSettler } from './modules/bank';
import { indexUntilCaughtUp, startIndexer } from './modules/indexer';
import { backfillManagedWallets, ensureLedgerScope, isManaged } from './modules/managed';
import { startTranscodeListener } from './modules/media';
import { getFeeBps, startSettlementWorker } from './modules/settlement';
import { startReaper } from './modules/watch';

async function main(): Promise<void> {
  const env = loadEnv();
  const ctx = createContext(env);
  const app = createApp(ctx);

  const background: Array<{ stop(): void | Promise<void> }> = [];
  background.push(startTranscodeListener(ctx));
  background.push(startReaper(ctx));

  // Balances and payments belong to one ledger; notice (and optionally clear them) when the app is pointed at another.
  try {
    await ensureLedgerScope(ctx);
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message }, 'ledger check failed; continuing');
  }

  if (env.PAYMENTS_MODE === 'bank') {
    background.push(startBankSettler(ctx));
  } else if (ctx.chain) {
    const chain = ctx.chain;
    // Chain features must never block API startup: failures are logged and retried by the background loops.
    void (async () => {
      try {
        await getFeeBps(ctx); // so the commission shown to users is the contract's, not a stale deployment record
        if (chain.relayerAddress) await chain.ensureRouterAllowance(10n ** 24n);
        await indexUntilCaughtUp(ctx);
      } catch (err) {
        ctx.logger.warn({ err: (err as Error).message }, 'initial chain sync failed; the indexer will keep retrying');
      }
    })();
    if (isManaged(ctx)) {
      // Built-in wallets need the current PaymentRouter. An older deployment has no creditBatch, so say so clearly.
      void chain.isCredited('0x' + '0'.repeat(64)).catch((err: Error) => {
        if (err.name === 'Reverted') ctx.logger.error('The deployed PaymentRouter does not support built-in wallets (no creditBatch). Deploy the current contract, or set WALLET_MODE=external.');
      });
      void backfillManagedWallets(ctx)
        .then((r) => (r.created || r.bonuses ? ctx.logger.info(r, 'prepared built-in wallets') : undefined))
        .catch((err: Error) => ctx.logger.warn({ err: err.message }, 'could not prepare built-in wallets; they are created on sign-in instead'));
    }
    background.push(startIndexer(ctx));
    background.push(startSettlementWorker(ctx));
  }

  const server = app.listen(env.PORT, () => {
    ctx.logger.info({ port: env.PORT, chainId: env.CHAIN_ID }, 'API listening');
    process.stdout.write(`API listening on :${env.PORT}\n`);
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await Promise.allSettled(background.map((b) => b.stop()));
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  process.stderr.write(`Fatal startup error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
