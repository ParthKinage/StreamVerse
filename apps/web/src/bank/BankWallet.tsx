import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api/client';
import { bankApi, walletApi } from '../api/endpoints';
import { keys, useConfig, useCreatorEarnings, useWalletSummary } from '../api/queries';
import { Field } from '../components/Field';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { useToast } from '../components/Toasts';
import { money, moneyTitle, timeAgo, toBig } from '../lib/format';
import { parseMoneyInput } from '../lib/money';
import { BankTopUpDialog } from './BankTopUpDialog';

function Stat({ label, wei, strong = false, testId }: { label: string; wei: string | undefined; strong?: boolean; testId?: string }): JSX.Element {
  return (
    <div className={`stat ${strong ? 'strong' : ''}`}>
      <p className="muted small">{label}</p>
      {wei === undefined ? (
        <Skeleton className="line" />
      ) : (
        <p className="stat-value" title={moneyTitle(wei)} data-testid={testId}>
          {money(wei)}
        </p>
      )}
    </div>
  );
}

function BankSelect({ id, value, onChange }: { id: string; value: string; onChange(v: string): void }): JSX.Element {
  const { data: config } = useConfig();
  const accounts = config?.bankAccounts ?? [];
  return (
    <div className="field">
      <label htmlFor={id}>Bank account</label>
      <select id={id} value={value || accounts[0]?.id || ''} onChange={(e) => onChange(e.target.value)}>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.kind}) ••{a.last4}
          </option>
        ))}
      </select>
    </div>
  );
}

function ReceivedCard(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: config } = useConfig();
  const earnings = useCreatorEarnings(true);
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const received = useInfiniteQuery({
    queryKey: keys.received,
    refetchInterval: 10_000,
    queryFn: ({ pageParam }) => bankApi.received(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const items = received.data?.pages.flatMap((p) => p.items) ?? [];
  const claimable = toBig(earnings.data?.claimableWei);

  const cashOut = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await bankApi.cashOut(accountId || config?.bankAccounts[0]?.id || '');
      toast.success(`${money(res.amountWei)} sent to your bank`);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.creatorEarnings }), qc.invalidateQueries({ queryKey: keys.transactions }), qc.invalidateQueries({ queryKey: keys.summary })]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Money received">
      <h2>Money received</h2>
      <div className="stats">
        <Stat label="Available to cash out" wei={earnings.data?.claimableWei} strong testId="creator-claimable" />
        <Stat label="Total received" wei={earnings.data?.lifetimeEarnedWei} testId="creator-lifetime" />
      </div>
      <BankSelect id="cashout-account" value={accountId} onChange={setAccountId} />
      <div className="actions">
        <button type="button" className="btn primary" disabled={busy || claimable === 0n} onClick={() => void cashOut()} data-testid="cash-out">
          {busy ? 'Sending…' : 'Cash out to bank'}
        </button>
      </div>
      <h3>Recent payments</h3>
      {received.isPending ? (
        <Skeleton className="block" />
      ) : received.isError ? (
        <ErrorState message={errorMessage(received.error)} onRetry={() => void received.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing received yet">When someone watches your paid videos, each payment shows up here.</EmptyState>
      ) : (
        <>
          <ul className="received-list" data-testid="received-list">
            {items.map((r) => (
              <li key={r.id} data-testid="received-row">
                <strong title={moneyTitle(r.amountWei)}>{money(r.amountWei)} received</strong> from {r.viewerName} for “{r.videoTitle}” · {timeAgo(r.receivedAt)}
              </li>
            ))}
          </ul>
          {received.hasNextPage ? (
            <div className="center">
              <button type="button" className="btn" onClick={() => void received.fetchNextPage()} disabled={received.isFetchingNextPage}>
                {received.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Wallet page for the simulated bank mode. */
export function BankWallet(): JSX.Element {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: config } = useConfig();
  const summaryQ = useWalletSummary();
  const summary = summaryQ.data;
  const isCreator = user?.role === 'CREATOR' || user?.role === 'ADMIN' || Boolean(user?.channelName);
  const [topUp, setTopUp] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const parsed = parseMoneyInput(amount);
  const withdrawError = 'error' in parsed ? parsed.error : summary && parsed.wei > toBig(summary.availableWei) ? `At most ${money(summary.availableWei)} can be sent back` : undefined;

  const txs = useInfiniteQuery({
    queryKey: keys.transactions,
    refetchInterval: 10_000,
    queryFn: ({ pageParam }) => walletApi.transactions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });

  const withdraw = async (): Promise<void> => {
    setTouched(true);
    if (withdrawError || !('wei' in parsed)) return;
    setBusy(true);
    try {
      await bankApi.withdraw(accountId || config?.bankAccounts[0]?.id || '', parsed.wei.toString());
      toast.success(`${money(parsed.wei)} sent to your bank`);
      setAmount('');
      setTouched(false);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.summary }), qc.invalidateQueries({ queryKey: keys.transactions })]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const rows = txs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="page">
      <h1>Wallet</h1>
      <p className="muted small">Prototype: money here is simulated. Nothing real is charged or paid out.</p>

      <section className="card" aria-label="Balance">
        <h2>Balance</h2>
        {summaryQ.isError ? (
          <ErrorState message={errorMessage(summaryQ.error)} onRetry={() => void summaryQ.refetch()} />
        ) : (
          <div className="stats">
            <Stat label="Available to watch" wei={summary?.availableWei} strong />
            <Stat label="Charges not yet settled" wei={summary?.unsettledChargesWei} />
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => setTopUp(true)} disabled={!config} data-testid="add-money">
            Add money
          </button>
        </div>
      </section>

      <section className="card" aria-label="Send money back to bank">
        <h2>Send back to bank</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void withdraw();
          }}
          noValidate
        >
          <BankSelect id="withdraw-account" value={accountId} onChange={setAccountId} />
          <Field label={`Amount (${config?.currencySymbol ?? '₹'})`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={touched ? withdrawError : undefined} autoComplete="off" />
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Sending…' : 'Send to bank'}
          </button>
        </form>
      </section>

      {isCreator ? <ReceivedCard /> : null}

      <section className="card" aria-label="Transactions">
        <h2>Transactions</h2>
        {txs.isPending ? (
          <Skeleton className="block" />
        ) : txs.isError ? (
          <ErrorState message={errorMessage(txs.error)} onRetry={() => void txs.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="No transactions yet">Added money, videos you watched and cash-outs show up here.</EmptyState>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const sign = t.type === 'DEPOSIT' || t.type === 'REWARD' ? '+' : '−';
                  return (
                    <tr key={t.id} data-testid="tx-row">
                      <td>{timeAgo(t.createdAt)}</td>
                      <td>{t.label}</td>
                      <td className="num" title={moneyTitle(t.amountWei)}>
                        {sign}
                        {money(t.amountWei)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {txs.hasNextPage ? (
              <div className="center">
                <button type="button" className="btn" onClick={() => void txs.fetchNextPage()} disabled={txs.isFetchingNextPage}>
                  {txs.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {topUp ? <BankTopUpDialog onClose={() => setTopUp(false)} /> : null}
    </div>
  );
}
