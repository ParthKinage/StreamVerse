import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

/** The same key index.html reads before the first paint, so a saved choice never flashes the other theme. */
export const THEME_KEY = 'streamverse.theme';

const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function system(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The theme in use: the viewer's choice, or their device's setting when they have not chosen. */
export function currentTheme(): Theme {
  const attr = typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined;
  return attr === 'light' || attr === 'dark' ? attr : (stored() ?? system());
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage blocked: the choice lasts for this visit only
  }
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  media?.addEventListener('change', fn);
  return () => {
    listeners.delete(fn);
    media?.removeEventListener('change', fn);
  };
};

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => 'dark');
}
