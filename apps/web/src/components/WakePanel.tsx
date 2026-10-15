import { useEffect, useState } from 'react';
import { useServerSlow } from '../lib/slowServer';
import { useTheme } from '../lib/theme';
import { CoinGame } from './CoinGame';

/**
 * Shown while the server takes a while to answer (on the free plan it sleeps after 15 idle minutes and needs about a
 * minute to wake). It explains the wait and offers a small game; it closes by itself when the server answers.
 */
export function WakePanel(): JSX.Element | null {
  const slow = useServerSlow();
  const theme = useTheme();
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (slow) setOpen(true);
    else {
      // Leave it up a moment so the game does not vanish mid-catch the instant the server answers.
      const t = setTimeout(() => {
        setOpen(false);
        setHidden(false);
      }, 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [slow]);

  if (!open || hidden) return null;
  return (
    <aside className="wake-panel" aria-label="The server is waking up" data-testid="wake-panel">
      <div className="wake-head">
        <span className="loader-bars" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <p role="status">
          <span className="eyebrow">{slow ? 'Waking up the server' : 'Ready'}</span>
          {slow ? 'This takes under a minute after a quiet spell. Catch some StreamCoins meanwhile.' : 'All set.'}
        </p>
        <button type="button" className="icon-btn" aria-label="Hide" onClick={() => setHidden(true)}>
          ×
        </button>
      </div>
      <CoinGame key={theme} />
    </aside>
  );
}
