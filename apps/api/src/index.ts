import { createApp } from './app';
import { loadEnv } from './config/env';
import { createContext } from './context';
import { startBankSettler } from './modules/bank';
import { indexUntilCaughtUp, startIndexer } from './modules/indexer';
import { startTranscodeListener } from './modules/media';
import { startSettlementWorker } from './modules/settlement';
import { startReaper } from './modules/watch';

async function main(): Promise<void> {
  const env = loadEnv();
  const ctx = createContext(env);
  const app = createApp(ctx);

  const background: Array<{ stop(): void | Promise<void> }> = [];
  background.push(startTranscodeListener(ctx));
  background.push(startReaper(ctx));

  if (env.PAYMENTS_MODE === 'bank') {
    background.push(startBankSettler(ctx));
  } else if (ctx.chain) {
    const chain = ctx.chain;
    // Chain features must never block API startup: failures are logged and retried by the background loops.
    void (async () => {
      try {
        if (chain.relayerAddress) await chain.ensureRouterAllowance(10n ** 24n);
        await indexUntilCaughtUp(ctx);
      } catch (err) {
        ctx.logger.warn({ err: (err as Error).message }, 'initial chain sync failed; the indexer will keep retrying');
      }
    })();
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
