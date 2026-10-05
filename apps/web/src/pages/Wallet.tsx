import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { formatSTRM } from '@tesor_gp/shared';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api/client';
import { walletApi } from '../api/endpoints';
import { keys, useBankMode, useWalletSummary } from '../api/queries';
import { BankWallet } from '../bank/BankWallet';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EarningsCard } from '../components/EarningsCard';
import { Field } from '../components/Field';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { useToast } from '../components/Toasts';
import { useChainRefresh } from '../hooks/useChainRefresh';
import { useNow } from '../hooks/useNow';
import { formatCountdown, shortAddress, strm, strmTitle, timeAgo, toBig } from '../lib/format';
import { isUserRejection } from '../wallet/eip1193';
import { gasBalance, getSigner, parseAmount, routerCall, tokenBalance, type RouterAction } from '../wallet/chainActions';
import { ConnectGate } from '../wallet/ConnectGate';
import { TopUpDialog } from '../wallet/TopUpDialog';
import { useWallet } from '../wallet/WalletContext';

function Balance({ label, wei, strong = false }: { label: string; wei: string | undefined; strong?: boolean }): JSX.Element {
  return (
    <div className={`stat ${strong ? 'strong' : ''}`}>
      <p className="muted small">{label}</p>
      {wei === undefined ? <Skeleton className="line" /> : <p className="stat-value" title={strmTitle(wei)}>{strm(wei)} <span className="unit">STRM</span></p>}
    </div>
  );
}

function ChainWalletPage(): JSX.Element {
  const { user, setUser } = useAuth();
  const { config, state } = useWallet();
  const toast = useToast();
  const refresh = useChainRefresh();
  const summaryQ = useWalletSummary();
  const isCreator = user?.role === 'CREATOR' || user?.role === 'ADMIN' || Boolean(user?.channelName);
  const summary = summaryQ.data;
  const [topUp, setTopUp] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawTouched, setWithdrawTouched] = useState(false);
  const [busy, setBusy] = useState<RouterAction | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [onChain, setOnChain] = useState<{ strm: bigint; gas: bigint } | null>(null);

  const now = useNow(1000, Boolean(summary?.withdrawUnlockAt));
  const unlockMs = summary?.withdrawUnlockAt ? Date.parse(summary.withdrawUnlockAt) - now : 0;
  const pendingWithdrawal = toBig(summary?.pendingWithdrawalWei);

  useEffect(() => {
    if (!config || state.status !== 'connected') return;
    void (async () => {
      try {
        const signer = await getSigner();
        const [s, g] = await Promise.all([tokenBalance(config, signer), gasBalance(signer)]);
        setOnChain({ strm: s, gas: g });
      } catch {
        setOnChain(null);
      }
    })();
  }, [config, state.status, state.address, summary?.escrowWei]);

  const explorer = config?.explorerUrl ? `${config.explorerUrl}/tx/` : null;
  const parsedWithdraw = parseAmount(withdrawAmount);
  const withdrawError = 'error' in parsedWithdraw ? parsedWithdraw.error : summary && parsedWithdraw.wei > toBig(summary.escrowWei) ? `At most ${strm(summary.escrowWei)} STRM can be withdrawn` : undefined;

  const run = async (action: RouterAction, label: string, changed: Parameters<typeof refresh>[0], amountWei?: bigint): Promise<void> => {
    if (!config) return;
    setBusy(action);
    try {
      await routerCall(config, action, (h) => setLastTx(h), amountWei);
      await refresh(changed);
      toast.success(`${label} confirmed`);
    } catch (err) {
      if (isUserRejection(err)) toast.info('Cancelled in your wallet. Nothing was changed.');
      else toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const unlink = async (): Promise<void> => {
    setUnlinking(true);
    try {
      const res = await walletApi.unlink();
      setUser(res.user);
      toast.success('Wallet unlinked');
      setConfirmUnlink(false);
    } catch (err) {
      toast.error(errorMessage(err));
      setConfirmUnlink(false);
    } finally {
      setUnlinking(false);
    }
  };

  const txs = useInfiniteQuery({
    queryKey: keys.transactions,
    refetchInterval: 10_000,
    queryFn: ({ pageParam }) => walletApi.transactions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    enabled: Boolean(user?.walletAddress),
  });

  return (
    <div className="page">
      <h1>Wallet</h1>

      <section className="card" aria-label="Wallet connection">
        <h2>Connection</h2>
        {user?.walletAddress ? <p className="muted">Linked wallet: <code title={user.walletAddress}>{shortAddress(user.walletAddress)}</code></p> : <p className="muted">No wallet linked yet.</p>}
        <ConnectGate>
          <p className="muted small">
            Connected: <code>{shortAddress(state.address)}</code>
            {onChain ? <> · Wallet balance: <span title={strmTitle(onChain.strm)}>{formatSTRM(onChain.strm, 4)} STRM</span></> : null}
          </p>
          {onChain && onChain.gas === 0n ? (
            <p className="notice" data-testid="faucet-note">
              You have no gas token yet. Get some from the{' '}
              <a href="https://faucet.polygon.technology/" target="_blank" rel="noreferrer noopener">
                Polygon faucet
              </a>
              .
            </p>
          ) : null}
        </ConnectGate>
        {user?.walletAddress ? (
          <button type="button" className="btn small" onClick={() => setConfirmUnlink(true)}>
            Unlink wallet
          </button>
        ) : null}
      </section>

      {user?.walletAddress ? (
        <>
          <section className="card" aria-label="Balance">
            <h2>Balance</h2>
            {summaryQ.isError ? (
              <ErrorState message={errorMessage(summaryQ.error)} onRetry={() => void summaryQ.refetch()} />
            ) : (
              <div className="stats">
                <Balance label="Available to watch" wei={summary?.availableWei} strong />
                <Balance label="In escrow" wei={summary?.escrowWei} />
                <Balance label="Charges not yet settled" wei={summary?.unsettledChargesWei} />
                <Balance label="Withdrawal pending" wei={summary?.pendingWithdrawalWei} />
              </div>
            )}
            <div className="actions">
              <button type="button" className="btn primary" onClick={() => setTopUp(true)} disabled={!config}>
                Top up
              </button>
            </div>
          </section>

          <section className="card" aria-label="Withdraw">
            <h2>Withdraw</h2>
            {pendingWithdrawal > 0n ? (
              <div data-testid="withdraw-pending">
                <p>
                  <strong>{strm(pendingWithdrawal)} STRM</strong> is waiting to be withdrawn.{' '}
                  {unlockMs > 0 ? <>Unlocks in <span data-testid="withdraw-countdown">{formatCountdown(unlockMs)}</span>.</> : 'It is ready to withdraw.'}
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={unlockMs > 0 || busy !== null}
                    onClick={() => void run('executeWithdraw', 'Withdrawal', (b, a) => toBig(a.pendingWithdrawalWei) === 0n && b !== undefined)}
                  >
                    {busy === 'executeWithdraw' ? 'Withdrawing…' : 'Withdraw now'}
                  </button>
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('cancelWithdraw', 'Cancellation', (_b, a) => toBig(a.pendingWithdrawalWei) === 0n)}>
                    {busy === 'cancelWithdraw' ? 'Cancelling…' : 'Cancel withdrawal'}
                  </button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setWithdrawTouched(true);
                  if (withdrawError || 'error' in parsedWithdraw) return;
                  void run('requestWithdraw', 'Withdrawal request', (_b, a) => toBig(a.pendingWithdrawalWei) > 0n, parsedWithdraw.wei);
                }}
                noValidate
              >
                <p className="muted small">Withdrawals unlock after {config ? Math.round(config.withdrawDelaySec / 60) : 15} minutes, so in-progress viewing can still be settled.</p>
                <Field label="Amount (STRM)" inputMode="decimal" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} error={withdrawTouched ? withdrawError : undefined} autoComplete="off" />
                <button type="submit" className="btn" disabled={busy !== null || (withdrawTouched && Boolean(withdrawError))}>
                  {busy === 'requestWithdraw' ? 'Requesting…' : 'Request withdrawal'}
                </button>
              </form>
            )}
          </section>

          {isCreator ? <EarningsCard /> : null}

          {lastTx && explorer ? (
            <p className="muted small">
              Last transaction:{' '}
              <a href={`${explorer}${lastTx}`} target="_blank" rel="noreferrer noopener">
                {shortAddress(lastTx)}
              </a>
            </p>
          ) : null}

          <section className="card" aria-label="Transactions">
            <h2>Transactions</h2>
            {txs.isPending ? (
              <Skeleton className="block" />
            ) : txs.isError ? (
              <ErrorState message={errorMessage(txs.error)} onRetry={() => void txs.refetch()} />
            ) : txs.data.pages.flatMap((p) => p.items).length === 0 ? (
              <EmptyState title="No transactions yet">Deposits, settlements and rewards will show up here.</EmptyState>
            ) : (
              <>
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>What</th>
                      <th className="num">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txs.data.pages
                      .flatMap((p) => p.items)
                      .map((t) => (
                        <tr key={t.id} data-testid="tx-row">
                          <td>{timeAgo(t.createdAt)}</td>
                          <td>
                            {t.label}{' '}
                            {t.explorerUrl ? (
                              <a href={t.explorerUrl} target="_blank" rel="noreferrer noopener" aria-label={`View ${t.label} on the explorer`}>
                                ↗
                              </a>
                            ) : null}
                          </td>
                          <td className="num" title={strmTitle(t.amountWei)}>
                            {strm(t.amountWei)} STRM
                          </td>
                          <td>{t.status === 'CONFIRMED' ? 'Confirmed' : t.status === 'PENDING' ? 'Pending' : 'Failed'}</td>
                        </tr>
                      ))}
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
        </>
      ) : null}

      {topUp ? <TopUpDialog onClose={() => setTopUp(false)} /> : null}
      {confirmUnlink ? (
        <ConfirmDialog
          title="Unlink wallet?"
          message="You will not be able to watch paid videos until you link a wallet again. Withdraw your escrow and claim earnings first; unlinking is refused while funds remain."
          confirmLabel="Unlink"
          danger
          pending={unlinking}
          onConfirm={() => void unlink()}
          onCancel={() => setConfirmUnlink(false)}
        />
      ) : null}
    </div>
  );
}

export default function WalletPage(): JSX.Element {
  return useBankMode() ? <BankWallet /> : <ChainWalletPage />;
}
