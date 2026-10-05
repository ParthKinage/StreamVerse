import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from '@tesor_gp/shared';
import { useAuth } from './AuthContext';
import { PageSpinner } from '../components/States';

/** Redirects anonymous visitors to /login and returns them to the page they asked for afterwards. */
export function RequireAuth({ children, role }: { children: ReactNode; role?: Role }): JSX.Element {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageSpinner label="Checking your session" />;
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  if (role && user.role !== role) {
    return (
      <div className="page narrow">
        <h1>Not allowed</h1>
        <p className="muted">You do not have access to this page.</p>
      </div>
    );
  }
  return <>{children}</>;
}
