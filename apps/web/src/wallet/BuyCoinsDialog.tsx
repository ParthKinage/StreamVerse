import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/client';
import { walletApi } from '../api/endpoints';
import { keys, useConfig, useWalletSummary } from '../api/queries';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toasts';
import { strm } from '../lib/format';
import { parseMoneyInput } from '../lib/money';

const QUICK = ['100', '250', '500', '1000'];

interface Props {
  onClose(): void;
  /** Called once the coins are in the wallet and can be spent (straight after the payment is accepted). */
  onDone?(): void;
  suggested?: string;
}

type Phase = { name: 'form' } | { name: 'done'; wei: bigint };

/**
 * Buy StreamCoins for the built-in wallet. The payment is a demo bank payment (nothing real is charged). The coins can
 * be spent at once; the platform records them on the blockchain in the background and pays the network fee, so the
 * buyer needs no crypto wallet and no gas.
 */
export function BuyCoinsDialog({ onClose, onDone, suggested }: Props): JSX.Element {
  const { data: config } = useConfig();
  const qc = useQueryClient();
  const toast = useToast();
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
    setBusy(true);
    try {
      const res = await walletApi.buyCoins(chosen, wei.toString());
      // The coins count at once (the server includes them in the balance); the blockchain record follows by itself.
      qc.setQueryData(keys.summary, res.summary);
      void qc.invalidateQueries({ queryKey: keys.transactions });
      setPhase({ name: 'done', wei });
      toast.success(`${strm(wei)} STRM added to your wallet`);
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (phase.name === 'done') {
    return (
      <Modal title="Coins added" onClose={onClose}>
        <p data-testid="coins-confirmed">{strm(phase.wei)} STRM is now in your wallet and ready to spend.</p>
        <p className="muted small">It is being recorded on the blockchain in the background; nothing else to do.</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
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
