import { Modal } from './Modal';

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ title, message, confirmLabel, danger = false, pending = false, onConfirm, onCancel }: Props): JSX.Element {
  return (
    <Modal title={title} onClose={onCancel} locked={pending}>
      <p>{message}</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={pending}>
          {pending ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
