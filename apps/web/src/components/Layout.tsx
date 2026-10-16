import { Suspense, useState, type FormEvent } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Search } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { Dock } from './Dock';
import { ErrorBoundary } from './ErrorBoundary';
import { PageSpinner } from './States';
import { WakePanel } from './WakePanel';
import { ThemeToggle } from './ThemeToggle';

export function Layout(): JSX.Element {
  const { user, logout } = useAuth();
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  const onSearch = (e: FormEvent): void => {
    e.preventDefault();
    const term = q.trim();
    navigate(term ? `/search?q=${encodeURIComponent(term)}` : '/search');
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-side" aria-hidden="true" />
        <div className="topbar-center">
          <Link to="/" className="brand">
            Stream<span className="brand-accent">Verse</span>
          </Link>
          <form className="search" role="search" onSubmit={onSearch}>
            <label className="sr-only" htmlFor="site-search">
              Search videos
            </label>
            <Search className="search-icon" size={16} aria-hidden />
            <input id="site-search" type="search" placeholder="Search videos and channels" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
        </div>
        <div className="topbar-tools">
          {user ? null : (
            <>
              <Link to="/login" className="btn small">
                Log in
              </Link>
              <Link to="/register" className="btn primary small">
                Sign up
              </Link>
            </>
          )}
          <ThemeToggle />
          {user ? (
            <button type="button" className="icon-btn squircle tool-btn" aria-label="Log out" title="Log out" onClick={() => void logout().then(() => navigate('/'))}>
              <LogOut size={18} aria-hidden />
            </button>
          ) : null}
        </div>
      </header>
      <Dock />
      <main id="main" className="main" tabIndex={-1}>
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<PageSpinner />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <WakePanel />
      <footer className="footer muted small">StreamVerse · pay only for what you watch</footer>
    </div>
  );
}
