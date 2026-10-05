import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  /** Prevents closing with Escape or the backdrop while a transaction is pending. */
  locked?: boolean;
}

/** Accessible dialog: focus moves in, Escape closes, Tab stays inside. */
export function Modal({ title, onClose, children, locked = false }: ModalProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, button, [href], select, textarea, [tabindex]:not([tabindex="-1"])');
    (first ?? ref.current)?.focus();
    return () => previous?.focus?.();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && !locked) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>('input, button, [href], select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute('disabled'));
    if (items.length === 0) return;
    const firstEl = items[0] as HTMLElement;
    const lastEl = items[items.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !locked && onClose()}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose} disabled={locked}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
