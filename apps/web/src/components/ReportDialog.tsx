import { useState } from 'react';
import type { ReportReason, ReportTarget } from '@tesor_gp/shared';
import { errorMessage } from '../api/client';
import { reportApi } from '../api/endpoints';
import { Modal } from './Modal';
import { useToast } from './Toasts';

const REASONS: Array<[ReportReason, string]> = [
  ['SPAM', 'Spam or scam'],
  ['ABUSE', 'Hateful or abusive'],
  ['SEXUAL', 'Sexual content'],
  ['COPYRIGHT', 'Copyright'],
  ['OTHER', 'Something else'],
];

const TITLES: Record<ReportTarget, string> = {
  VIDEO: 'Report this video',
  CHAT_MESSAGE: 'Report this message',
  CHANNEL: 'Report this channel',
};

/** Asks why something is being reported and sends it to the admins' queue. */
export function ReportDialog({ targetType, targetId, onClose }: { targetType: ReportTarget; targetId: string; onClose(): void }): JSX.Element {
  const toast = useToast();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  return (
    <Modal title={TITLES[targetType]} onClose={onClose} locked={sending}>
      <form
        className="form report-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!reason) return setError('Choose a reason');
          setError(null);
          setSending(true);
          reportApi
            .create({ targetType, targetId, reason, ...(details.trim() ? { details: details.trim() } : {}) })
            .then(() => {
              toast.success('Thanks. Our team will review it.');
              onClose();
            })
            .catch((err) => setError(errorMessage(err)))
            .finally(() => setSending(false));
        }}
      >
        <fieldset className="report-reasons">
          <legend className="sr-only">Reason</legend>
          {REASONS.map(([value, label]) => (
            <label key={value} className="check">
              <input type="radio" name="report-reason" checked={reason === value} onChange={() => setReason(value)} /> {label}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="report-details">Anything else (optional)</label>
          <textarea id="report-details" rows={3} maxLength={500} value={details} onChange={(e) => setDetails(e.target.value)} />
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={sending} data-testid="send-report">
            {sending ? 'Sending…' : 'Send report'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
