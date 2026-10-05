import { Suspense, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useWalletSummary } from '../api/queries';
import { isBankMode, money, moneyTitle, shortAddress } from '../lib/format';
import { useWallet } from '../wallet/WalletContext';
import { ErrorBoundary } from './ErrorBoundary';
import { PageSpinner } from './States';

export function Layout(): JSX.Element {
  const { user, logout } = useAuth();
  const { state } = useWallet();
  const { data: summary } = useWalletSummary();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  const onSearch = (e: FormEvent): void => {
    e.preventDefault();
    const term = q.trim();
    setOpen(false);
    navigate(term ? `/search?q=${encodeURIComponent(term)}` : '/search');
  };
  const link = ({ isActive }: { isActive: boolean }): string => (isActive ? 'active' : '');

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand" onClick={() => setOpen(false)}>
          StreamVerse
        </Link>
        <button type="button" className="icon-btn menu-toggle" aria-label="Toggle menu" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen((o) => !o)}>
          ☰
        </button>
        <nav id="site-nav" className={`nav ${open ? 'open' : ''}`} aria-label="Main">
          <form className="search" role="search" onSubmit={onSearch}>
            <label className="sr-only" htmlFor="site-search">
              Search videos
            </label>
            <input id="site-search" type="search" placeholder="Search videos" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <NavLink to="/" end className={link} onClick={() => setOpen(false)}>
            Home
          </NavLink>
          {user ? (
            <>
              <NavLink to="/watchlist" className={link} onClick={() => setOpen(false)}>
                Watchlist
              </NavLink>
              <NavLink to="/history" className={link} onClick={() => setOpen(false)}>
                History
              </NavLink>
              <NavLink to="/studio" className={link} onClick={() => setOpen(false)}>
                Studio
              </NavLink>
              {user.role === 'ADMIN' ? (
                <NavLink to="/admin" className={link} onClick={() => setOpen(false)}>
                  Admin
                </NavLink>
              ) : null}
              <NavLink to="/wallet" className={`wallet-chip ${link({ isActive: location.pathname.startsWith('/wallet') })}`} onClick={() => setOpen(false)}>
                <span className="sr-only">Wallet balance: </span>
                {(isBankMode() || user.walletAddress) && summary ? (
                  <span title={moneyTitle(summary.availableWei)} data-testid="nav-balance">
                    {money(summary.availableWei)}
                  </span>
                ) : (
                  <span>{!isBankMode() && state.address ? shortAddress(state.address) : 'Wallet'}</span>
                )}
              </NavLink>
              <NavLink to="/settings" className={link} onClick={() => setOpen(false)}>
                {user.username}
              </NavLink>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  setOpen(false);
                  void logout().then(() => navigate('/'));
                }}
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <NavLink to="/login" className={link} onClick={() => setOpen(false)}>
                Log in
              </NavLink>
              <Link to="/register" className="btn primary small" onClick={() => setOpen(false)}>
                Sign up
              </Link>
            </>
          )}
        </nav>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<PageSpinner />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <footer className="footer muted small">StreamVerse · pay only for the seconds you watch</footer>
    </div>
  );
}
