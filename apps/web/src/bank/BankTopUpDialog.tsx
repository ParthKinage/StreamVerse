import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/client';
import { bankApi } from '../api/endpoints';
import { keys, useConfig } from '../api/queries';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toasts';
import { money } from '../lib/format';
import { parseMoneyInput } from '../lib/money';

const QUICK = ['100', '250', '500', '1000'];

interface Props {
  onClose(): void;
  /** Called after the money has been added to the wallet. */
  onDone?(): void;
  suggested?: string;
}

/** Prototype "add money from your bank": pick a dummy account, pick an amount, done. No real money moves. */
export function BankTopUpDialog({ onClose, onDone, suggested }: Props): JSX.Element {
  const { data: config } = useConfig();
  const qc = useQueryClient();
  const toast = useToast();
  const accounts = config?.bankAccounts ?? [];
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState(suggested ?? '500');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<bigint | null>(null);

  const chosen = accountId || accounts[0]?.id || '';
  const parsed = parseMoneyInput(amount);
  let amountError: string | undefined = 'error' in parsed ? parsed.error : undefined;
  if (!amountError && 'wei' in parsed && config) {
    if (parsed.wei < BigInt(config.minTopUpWei)) amountError = `Minimum is ${money(config.minTopUpWei)}`;
    else if (parsed.wei > BigInt(config.maxTopUpWei)) amountError = `Maximum is ${money(config.maxTopUpWei)}`;
  }

  const submit = async (): Promise<void> => {
    setTouched(true);
    setError(null);
    if (amountError || !('wei' in parsed) || !chosen) return;
    setBusy(true);
    try {
      await bankApi.topUp(chosen, parsed.wei.toString());
      await Promise.all([qc.invalidateQueries({ queryKey: keys.summary }), qc.invalidateQueries({ queryKey: keys.transactions })]);
      setAdded(parsed.wei);
      toast.success(`${money(parsed.wei)} added to your wallet`);
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (added !== null) {
    return (
      <Modal title="Money added" onClose={onClose}>
        <p data-testid="topup-confirmed">{money(added)} was added to your wallet.</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add money from your bank" onClose={onClose} locked={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <p className="muted small">This is a prototype. Pick a demo bank account; no real money is involved.</p>
        <div className="field">
          <label htmlFor="bank-account">Bank account</label>
          <select id="bank-account" data-testid="bank-account" value={chosen} onChange={(e) => setAccountId(e.target.value)} disabled={busy}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.kind}) ••{a.last4}
              </option>
            ))}
          </select>
        </div>
        <Field
          label={`Amount (${config?.currencySymbol ?? '₹'})`}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={touched ? amountError : undefined}
          autoComplete="off"
          data-testid="bank-amount"
        />
        <div className="actions">
          {QUICK.map((q) => (
            <button key={q} type="button" className="btn small" onClick={() => setAmount(q)} disabled={busy}>
              {config?.currencySymbol ?? '₹'}
              {q}
            </button>
          ))}
        </div>
        {error ? (
          <p className="form-error" role="alert" data-testid="bank-error">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy || (touched && Boolean(amountError))} data-testid="bank-submit">
            {busy ? 'Contacting your bank…' : 'Add money'}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
