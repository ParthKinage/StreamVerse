import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatSTRM } from '@tesor_gp/shared';
import { Modal } from '../components/Modal';
import { Field } from '../components/Field';
import { useToast } from '../components/Toasts';
import { errorMessage } from '../api/client';
import { keys, useWalletSummary } from '../api/queries';
import { toBig } from '../lib/format';
import { isUserRejection } from './eip1193';
import { gasBalance, getSigner, parseAmount, tokenBalance, topUp, type TopUpStep } from './chainActions';
import { ConnectGate } from './ConnectGate';
import { useWallet } from './WalletContext';

type Phase = 'form' | 'working' | 'confirmed';

const STEP_LABEL: Record<TopUpStep, string> = {
  signing: 'Sign the permit in your wallet (no gas)',
  'permit-fallback-approve': 'Approving STRM for the payment contract',
  depositing: 'Confirm the deposit in your wallet',
};

interface Props {
  onClose(): void;
  /** Called after the deposit is confirmed on-chain and the balance shows in the API. */
  onDone?(): void;
  suggestedStrm?: string;
}

export function TopUpDialog({ onClose, onDone, suggestedStrm }: Props): JSX.Element {
  const { config } = useWallet();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: summary } = useWalletSummary();
  const [amount, setAmount] = useState(suggestedStrm ?? '10');
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [step, setStep] = useState<TopUpStep | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [gasZero, setGasZero] = useState(false);
  const [walletStrm, setWalletStrm] = useState<bigint | null>(null);
  const baselineRef = useRef<bigint>(0n);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!config) return;
    void (async () => {
      try {
        const signer = await getSigner();
        const [gas, strm] = await Promise.all([gasBalance(signer), tokenBalance(config, signer)]);
        if (mounted.current) {
          setGasZero(gas === 0n);
          setWalletStrm(strm);
        }
      } catch {
        // Balance hints are optional.
      }
    })();
  }, [config]);

  const parsed = parseAmount(amount);
  const amountError = 'error' in parsed ? parsed.error : walletStrm !== null && parsed.wei > walletStrm ? `Your wallet holds ${formatSTRM(walletStrm, 4)} STRM` : undefined;
  const explorer = config?.explorerUrl ? `${config.explorerUrl}/tx/` : null;

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (!config || 'error' in parsed || amountError) return;
    setPhase('working');
    setError(null);
    setNotice(null);
    baselineRef.current = toBig(summary?.escrowWei);
    try {
      await topUp(config, parsed.wei, { onStep: (s) => mounted.current && setStep(s), onTx: (h) => mounted.current && setTxHash(h) }, isUserRejection);
      // The API balance follows the chain indexer; wait (briefly) until it reflects the deposit.
      for (let i = 0; i < 30; i++) {
        await qc.invalidateQueries({ queryKey: keys.summary });
        const fresh = qc.getQueryData<{ escrowWei: string }>(keys.summary);
        if (toBig(fresh?.escrowWei) >= baselineRef.current + parsed.wei) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      await qc.invalidateQueries({ queryKey: keys.transactions });
      if (!mounted.current) return;
      setPhase('confirmed');
      toast.success('Deposit confirmed');
      onDone?.();
    } catch (err) {
      if (!mounted.current) return;
      setPhase('form');
      if (isUserRejection(err)) setNotice('Cancelled in your wallet. Nothing was spent.');
      else setError(errorMessage(err));
    }
  };

  return (
    <Modal title="Top up balance" onClose={onClose} locked={phase === 'working'}>
      <ConnectGate>
        {gasZero ? (
          <p className="notice" data-testid="gas-note">
            Your wallet has no gas token. Get some from the{' '}
            <a href="https://faucet.polygon.technology/" target="_blank" rel="noreferrer noopener">
              Polygon faucet
            </a>{' '}
            before depositing.
          </p>
        ) : null}
        {phase === 'confirmed' ? (
          <div role="status" data-testid="topup-confirmed">
            <p>Your deposit is confirmed and ready to use.</p>
            {txHash && explorer ? (
              <a href={`${explorer}${txHash}`} target="_blank" rel="noreferrer noopener">
                View transaction
              </a>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            noValidate
          >
            <Field
              label="Amount (STRM)"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onBlur={() => setTouched(true)}
              disabled={phase === 'working'}
              error={touched ? amountError : undefined}
              hint={walletStrm !== null ? `Wallet balance: ${formatSTRM(walletStrm, 4)} STRM` : undefined}
              autoComplete="off"
            />
            {phase === 'working' ? (
              <ol className="steps" aria-live="polite" data-testid="topup-steps">
                <li className={step ? 'done' : 'active'}>Starting</li>
                {step ? <li className="active">{STEP_LABEL[step]}</li> : null}
                {txHash ? (
                  <li className="active">
                    Waiting for confirmation{' '}
                    {explorer ? (
                      <a href={`${explorer}${txHash}`} target="_blank" rel="noreferrer noopener">
                        (view transaction)
                      </a>
                    ) : null}
                  </li>
                ) : null}
              </ol>
            ) : null}
            {notice ? (
              <p className="notice" role="status">
                {notice}
              </p>
            ) : null}
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onClose} disabled={phase === 'working'}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={phase === 'working' || Boolean(touched && amountError)}>
                {phase === 'working' ? 'Working…' : 'Deposit'}
              </button>
            </div>
          </form>
        )}
      </ConnectGate>
    </Modal>
  );
}
