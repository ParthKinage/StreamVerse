import { setTheme, useTheme } from '../lib/theme';

/** Switches between the dark (onyx) and light (bone) themes; the choice is remembered on this device. */
export function ThemeToggle(): JSX.Element {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="icon-btn theme-toggle" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} data-testid="theme-toggle">
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
