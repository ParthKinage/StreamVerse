import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserDto } from '@tesor_gp/shared';
import { authApi } from '../api/endpoints';
import { refreshAccessToken, setAuthLostHandler, setTokenRefreshedHandler, tokenStore } from '../api/client';

interface AuthState {
  user: UserDto | null;
  /** True until the first silent refresh attempt has finished. */
  loading: boolean;
  /** True when the session ended unexpectedly (failed refresh); pages use it to redirect with a return path. */
  sessionLost: boolean;
  setSession(token: string, user: UserDto): void;
  setUser(user: UserDto): void;
  logout(): Promise<void>;
  acknowledgeSessionLost(): void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUserState] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionLost, setSessionLost] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    setTokenRefreshedHandler((_t, u) => setUserState(u));
    setAuthLostHandler(() => {
      setUserState((prev) => {
        if (prev) setSessionLost(true);
        return null;
      });
      qc.clear();
    });
    let cancelled = false;
    void (async () => {
      await refreshAccessToken(); // silent sign-in from the refresh cookie; a failure just means "signed out"
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
      setTokenRefreshedHandler(null);
    };
  }, [qc]);

  const setSession = useCallback((token: string, u: UserDto) => {
    tokenStore.set(token);
    setUserState(u);
    setSessionLost(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // The cookie is cleared client-side state either way.
    }
    tokenStore.set(null);
    setUserState(null);
    qc.clear();
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({ user, loading, sessionLost, setSession, setUser: setUserState, logout, acknowledgeSessionLost: () => setSessionLost(false) }),
    [user, loading, sessionLost, setSession, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
