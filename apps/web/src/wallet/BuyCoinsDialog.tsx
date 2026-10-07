import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WalletSummary } from '@tesor_gp/shared';
import { errorMessage } from '../api/client';
import { walletApi } from '../api/endpoints';
import { keys, useConfig, useWalletSummary } from '../api/queries';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toasts';
import { useChainRefresh } from '../hooks/useChainRefresh';
import { strm, toBig } from '../lib/format';
import { parseMoneyInput } from '../lib/money';

const QUICK = ['100', '250', '500', '1000'];

interface Props {
  onClose(): void;
  /** Called once the coins are in the wallet and can be spent. */
  onDone?(): void;
  suggested?: string;
}

type Phase = { name: 'form' } | { name: 'arriving'; wei: bigint } | { name: 'slow'; wei: bigint } | { name: 'done'; wei: bigint };

/**
 * Buy StreamCoins for the built-in wallet. The payment is a demo bank payment (nothing real is charged); the platform
 * then writes the purchase to the blockchain and pays the network fee, so the buyer needs no crypto wallet and no gas.
 */
export function BuyCoinsDialog({ onClose, onDone, suggested }: Props): JSX.Element {
  const { data: config } = useConfig();
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useChainRefresh();
  // Keeps the balance query live while this dialog waits for the purchase to be confirmed.
  useWalletSummary();
  const accounts = config?.bankAccounts ?? [];
  const symbol = config?.fiatSymbol || '₹';
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState(suggested ?? '500');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'form' });

  const chosen = accountId || accounts[0]?.id || '';
  const parsed = parseMoneyInput(amount);
  let amountError: string | undefined = 'error' in parsed ? parsed.error : undefined;
  if (!amountError && 'wei' in parsed && config) {
    if (parsed.wei < BigInt(config.minTopUpWei)) amountError = `Minimum is ${strm(config.minTopUpWei)} STRM`;
    else if (parsed.wei > BigInt(config.maxTopUpWei)) amountError = `Maximum is ${strm(config.maxTopUpWei)} STRM`;
  }

  const submit = async (): Promise<void> => {
    setTouched(true);
    setError(null);
    if (amountError || !('wei' in parsed) || !chosen) return;
    const wei = parsed.wei;
    const before = toBig(qc.getQueryData<WalletSummary>(keys.summary)?.availableWei);
    setBusy(true);
    try {
      const res = await walletApi.buyCoins(chosen, wei.toString());
      qc.setQueryData(keys.summary, res.summary);
      void qc.invalidateQueries({ queryKey: keys.transactions });
      setPhase({ name: 'arriving', wei });
      // The purchase is accepted; now wait for it to be confirmed on the blockchain.
      const result = { arrived: false };
      await refresh((_b, after) => {
        // Spendable only once the indexer has seen the confirmed credit, so wait for the balance itself to rise.
        result.arrived = toBig(after.arrivingWei) === 0n && toBig(after.availableWei) >= before + wei;
        return result.arrived;
      });
      if (result.arrived) {
        setPhase({ name: 'done', wei });
        toast.success(`${strm(wei)} STRM added to your wallet`);
        onDone?.();
      } else {
        setPhase({ name: 'slow', wei });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (phase.name === 'done') {
    return (
      <Modal title="Coins added" onClose={onClose}>
        <p data-testid="coins-confirmed">{strm(phase.wei)} STRM is now in your wallet.</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }
  if (phase.name === 'arriving' || phase.name === 'slow') {
    return (
      <Modal title="Payment accepted" onClose={onClose} locked={phase.name === 'arriving'}>
        <p data-testid="coins-arriving" role="status">
          {phase.name === 'arriving'
            ? `Adding ${strm(phase.wei)} STRM to your wallet on the blockchain. This usually takes a few seconds.`
            : `Your ${strm(phase.wei)} STRM is taking longer than usual. It is safe: it will appear in your wallet as soon as the blockchain confirms it.`}
        </p>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose} disabled={phase.name === 'arriving'}>
            {phase.name === 'arriving' ? 'Please wait…' : 'Close'}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Buy StreamCoins" onClose={onClose} locked={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <p className="muted small">
          {symbol}1 buys 1 STRM. This is a demo payment from a demo bank account: no real money is charged. StreamVerse pays the blockchain fee.
        </p>
        <div className="field">
          <label htmlFor="coin-account">Pay from</label>
          <select id="coin-account" data-testid="coin-account" value={chosen} onChange={(e) => setAccountId(e.target.value)} disabled={busy}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.kind}) ••{a.last4}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Coins to buy (STRM)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={touched ? amountError : undefined}
          autoComplete="off"
          data-testid="coin-amount"
        />
        <div className="actions">
          {QUICK.map((q) => (
            <button key={q} type="button" className="btn small" onClick={() => setAmount(q)} disabled={busy}>
              {q} STRM
            </button>
          ))}
        </div>
        {error ? (
          <p className="form-error" role="alert" data-testid="coin-error">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy || (touched && Boolean(amountError))} data-testid="coin-submit">
            {busy ? 'Contacting your bank…' : 'wei' in parsed ? `Pay ${symbol}${strm(parsed.wei)}` : 'Pay'}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
