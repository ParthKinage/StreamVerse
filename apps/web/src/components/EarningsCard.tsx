import { useState } from 'react';
import { errorMessage } from '../api/client';
import { useConfig, useCreatorEarnings } from '../api/queries';
import { useChainRefresh } from '../hooks/useChainRefresh';
import { strm, strmTitle, toBig } from '../lib/format';
import { isUserRejection } from '../wallet/eip1193';
import { routerCall } from '../wallet/chainActions';
import { ConnectGate } from '../wallet/ConnectGate';
import { Skeleton } from './States';
import { useToast } from './Toasts';

function Stat({ label, wei, strong = false }: { label: string; wei: string | undefined; strong?: boolean }): JSX.Element {
  return (
    <div className={`stat ${strong ? 'strong' : ''}`}>
      <p className="muted small">{label}</p>
      {wei === undefined ? (
        <Skeleton className="line" />
      ) : (
        <p className="stat-value" title={strmTitle(wei)}>
          {strm(wei)} <span className="unit">STRM</span>
        </p>
      )}
    </div>
  );
}

/** Creator earnings with an on-chain claim. */
export function EarningsCard(): JSX.Element {
  const { data: config } = useConfig();
  const q = useCreatorEarnings(true);
  const refresh = useChainRefresh();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const claim = async (): Promise<void> => {
    if (!config) return;
    setBusy(true);
    try {
      await routerCall(config, 'claimEarnings', () => undefined);
      await refresh(() => true);
      toast.success('Earnings claimed to your wallet');
    } catch (err) {
      if (isUserRejection(err)) toast.info('Cancelled in your wallet. Nothing was changed.');
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Creator earnings">
      <h2>Earnings</h2>
      <div className="stats">
        <Stat label="Claimable now" wei={q.data?.claimableWei} strong />
        <Stat label="Waiting to settle" wei={q.data?.pendingSettlementWei} />
        <Stat label="Lifetime earned" wei={q.data?.lifetimeEarnedWei} />
      </div>
      <ConnectGate>
        <button type="button" className="btn primary" disabled={busy || toBig(q.data?.claimableWei) === 0n} onClick={() => void claim()}>
          {busy ? 'Claiming…' : 'Claim earnings'}
        </button>
      </ConnectGate>
    </section>
  );
}
