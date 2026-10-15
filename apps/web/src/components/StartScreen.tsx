import { useServerSlow } from '../lib/slowServer';
import { useTheme } from '../lib/theme';
import { CoinGame } from './CoinGame';

/**
 * The first screen, while the app asks the server for its settings. On the free plan the server may be asleep and
 * need about a minute; once the wait gets long, StreamCoins start falling across the whole screen and the visitor can
 * catch them with a tray along the bottom. The app replaces this screen as soon as the server answers.
 */
export function StartScreen(): JSX.Element {
  const slow = useServerSlow();
  const theme = useTheme();
  return (
    <div className="start-screen" role="status" aria-live="polite">
      {slow ? <CoinGame key={theme} variant="full" /> : null}
      <div className="start-copy">
        <span className="loader-bars" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="start-mark">STREAMVERSE</span>
        {slow ? (
          <>
            <p className="start-title">Waking up the server</p>
            <p className="start-note">This takes under a minute after a quiet spell. Catch the falling StreamCoins meanwhile: move the mouse or use the arrow keys.</p>
          </>
        ) : (
          <span className="sr-only">Starting StreamVerse</span>
        )}
      </div>
    </div>
  );
}
