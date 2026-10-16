import { useRef, type MouseEvent } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Clapperboard, Compass, History, Home, Library, Settings, ShieldCheck, Users, Wallet, type LucideIcon } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useWalletSummary } from '../api/queries';
import { isBankMode, money, shortAddress } from '../lib/format';
import { useOnAir } from '../live/onAir';
import { useWallet } from '../wallet/WalletContext';

interface Item {
  to: string;
  label: string;
  Icon: LucideIcon;
  end?: boolean;
  extra?: JSX.Element;
  /** Read out with the label (the account name on Settings). */
  detail?: string;
}

/** How far (px) from the pointer an icon still grows, and by how much at most (like the macOS Dock). */
const REACH = 110;
const GROW = 0.6;

const canMagnify = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 721px)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The app's main navigation: an island of squircle icons on the left. Icons near the pointer grow and the one under it
 * shows its name; on a phone the island becomes a bar along the bottom.
 */
export function Dock(): JSX.Element {
  const { user } = useAuth();
  const { state } = useWallet();
  const { data: summary } = useWalletSummary();
  const onAir = useOnAir();
  const listRef = useRef<HTMLUListElement>(null);

  const balance = (isBankMode() || user?.walletAddress) && summary ? money(summary.availableWei) : !isBankMode() && state.address ? shortAddress(state.address) : null;
  const items: Item[] = [
    { to: '/', label: 'Home', Icon: Home, end: true },
    { to: '/search', label: 'Browse', Icon: Compass },
    ...(user
      ? [
          { to: '/following', label: 'Following', Icon: Users },
          { to: '/watchlist', label: 'Library', Icon: Library },
          { to: '/history', label: 'History', Icon: History },
          { to: '/studio', label: 'Studio', Icon: Clapperboard },
          {
            to: '/wallet',
            label: 'Wallet',
            Icon: Wallet,
            extra: balance ? (
              <span className="dock-sub" data-testid="nav-balance">
                {balance}
              </span>
            ) : undefined,
          },
          { to: '/settings', label: 'Settings', Icon: Settings, detail: user.username, extra: <span className="dock-sub">{user.username}</span> },
          ...(user.role === 'ADMIN' ? [{ to: '/admin', label: 'Admin', Icon: ShieldCheck }] : []),
        ]
      : []),
  ];

  const magnify = (e: MouseEvent): void => {
    const list = listRef.current;
    if (!list || !canMagnify()) return;
    for (const el of list.querySelectorAll<HTMLElement>('.dock-item')) {
      const r = el.getBoundingClientRect();
      const d = Math.abs(e.clientY - (r.top + r.height / 2));
      const s = 1 + GROW * Math.max(0, Math.cos(Math.min(d / REACH, 1) * (Math.PI / 2)));
      el.style.setProperty('--s', s.toFixed(3));
    }
  };
  const reset = (): void => {
    for (const el of listRef.current?.querySelectorAll<HTMLElement>('.dock-item') ?? []) el.style.removeProperty('--s');
  };

  return (
    <nav className="dock" aria-label="Main">
      <ul ref={listRef} className="dock-island" onMouseMove={magnify} onMouseLeave={reset}>
        {items.map(({ to, label, Icon, end, extra, detail }) => (
          <li key={to} className="dock-item">
            <NavLink to={to} end={end} aria-label={detail ? `${label}, ${detail}` : label} className={({ isActive }) => `dock-link${isActive ? ' active' : ''}`}>
              <span className="dock-icon squircle">
                <Icon size={22} strokeWidth={1.9} aria-hidden />
              </span>
              <span className="dock-label">
                {label}
                {extra}
              </span>
            </NavLink>
          </li>
        ))}
        {onAir ? (
          <li className="dock-item">
            <Link to="/studio?tab=live" className="dock-link dock-live" aria-label="You’re live: open the stream controls" data-testid="nav-live">
              <span className="dock-icon squircle">
                <span className="live-dot" aria-hidden="true" />
              </span>
              <span className="dock-label">You’re live</span>
            </Link>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
