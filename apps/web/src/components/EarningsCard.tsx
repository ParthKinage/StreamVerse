import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/client';
import { creatorApi } from '../api/endpoints';
import { keys, useConfig, useCreatorEarnings, useManagedMode } from '../api/queries';
import { useChainRefresh } from '../hooks/useChainRefresh';
import { strm, strmTitle, toBig } from '../lib/format';
import { isUserRejection } from '../wallet/eip1193';
import { routerCall } from '../wallet/chainActions';
import { ConnectGate } from '../wallet/ConnectGate';
import { Skeleton } from './States';
import { useToast } from './Toasts';

function Stat({ label, wei, strong = false, testId }: { label: string; wei: string | undefined; strong?: boolean; testId?: string }): JSX.Element {
  return (
    <div className={`stat ${strong ? 'strong' : ''}`}>
      <p className="muted small">{label}</p>
      {wei === undefined ? (
        <Skeleton className="line" />
      ) : (
        <p className="stat-value" title={strmTitle(wei)} data-testid={testId}>
          {strm(wei)} <span className="unit">STRM</span>
        </p>
      )}
    </div>
  );
}

/** Built-in wallets: the platform sends the payout and pays the network fee; the creator only presses the button. */
function ManagedEarnings(): JSX.Element {
  const { data: config } = useConfig();
  const q = useCreatorEarnings(true);
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const claimable = toBig(q.data?.claimableWei);
  const minimum = toBig(config?.minPayoutWei);
  const pending = busy || Boolean(q.data?.payoutPending);
  const commission = config ? config.feeBps / 100 : null;

  const payout = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await creatorApi.payout();
      toast.success(`${strm(res.amountWei)} STRM is on its way to your wallet`);
      await qc.invalidateQueries({ queryKey: keys.creatorEarnings });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Creator earnings">
      <h2>Earnings</h2>
      <div className="stats">
        <Stat label="Ready to pay out" wei={q.data?.claimableWei} strong testId="earnings-claimable" />
        <Stat label="Being confirmed" wei={q.data?.pendingSettlementWei} />
        <Stat label="Paid to your wallet" wei={q.data?.paidOutWei} testId="earnings-paid" />
        <Stat label="Lifetime earned" wei={q.data?.lifetimeEarnedWei} />
      </div>
      {commission !== null ? (
        <p className="muted small">
          You keep {100 - commission}% of every sale. StreamVerse keeps {commission}% and pays all blockchain fees for you and your viewers.
        </p>
      ) : null}
      <div className="actions">
        <button type="button" className="btn primary" disabled={pending || claimable === 0n || claimable < minimum} onClick={() => void payout()} data-testid="payout">
          {q.data?.payoutPending ? 'Payout on its way…' : busy ? 'Requesting…' : 'Pay out to my wallet'}
        </button>
      </div>
      {claimable > 0n && claimable < minimum ? <p className="muted small">Payouts start at {strm(minimum)} STRM.</p> : null}
    </section>
  );
}

/** Linked browser wallets: the creator claims on-chain from their own wallet. */
function ExternalEarnings(): JSX.Element {
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

/** Creator earnings with a payout to the creator's wallet. */
export function EarningsCard(): JSX.Element {
  const { isPending } = useConfig();
  const managed = useManagedMode();
  if (isPending) return <Skeleton className="block" />;
  return managed ? <ManagedEarnings /> : <ExternalEarnings />;
}
