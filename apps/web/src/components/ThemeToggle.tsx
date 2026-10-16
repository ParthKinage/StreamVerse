import { Moon, Sun } from 'lucide-react';
import { setTheme, useTheme } from '../lib/theme';

/** Switches between the dark (graphite) and light (concrete) themes; the choice is remembered on this device. */
export function ThemeToggle(): JSX.Element {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="icon-btn squircle tool-btn theme-toggle" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} data-testid="theme-toggle">
      {theme === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </button>
  );
}
