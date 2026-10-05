import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WalletSummary } from '@tesor_gp/shared';
import { keys } from '../api/queries';

/**
 * Balances come from the API, which follows the chain through the indexer. After a confirmed transaction we poll
 * the summary until `changed` says it reflects the transaction (or a timeout passes), then refresh dependent data.
 */
export function useChainRefresh(): (changed: (before: WalletSummary | undefined, after: WalletSummary) => boolean) => Promise<void> {
  const qc = useQueryClient();
  return useCallback(
    async (changed) => {
      const before = qc.getQueryData<WalletSummary>(keys.summary);
      for (let i = 0; i < 30; i++) {
        await qc.invalidateQueries({ queryKey: keys.summary });
        const after = qc.getQueryData<WalletSummary>(keys.summary);
        if (after && changed(before, after)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      await Promise.all([qc.invalidateQueries({ queryKey: keys.transactions }), qc.invalidateQueries({ queryKey: keys.creatorEarnings })]);
    },
    [qc],
  );
}
