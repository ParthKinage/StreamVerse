import { loadEnv } from '../config/env';
import { createContext } from '../context';
import { reconcile } from '../modules/settlement';
import { formatSTRMFull } from '@tesor_gp/shared';

/** Compares database escrow with the chain for every linked wallet. Exit code 1 if any mismatch is found. */
async function main(): Promise<void> {
  const ctx = createContext(loadEnv());
  try {
    const { checked, mismatches } = await reconcile(ctx);
    console.log(`Checked ${checked} escrow account(s).`);
    if (mismatches.length === 0) {
      console.log('OK: database and chain agree (diff = 0).');
      return;
    }
    for (const m of mismatches) {
      console.log(
        `MISMATCH ${m.address}: db escrow ${formatSTRMFull(m.dbEscrow)} vs chain ${formatSTRMFull(m.chainEscrow)}; ` +
          `db pending ${formatSTRMFull(m.dbPending)} vs chain ${formatSTRMFull(m.chainPending)}; diff ${m.diff}`,
      );
    }
    process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
