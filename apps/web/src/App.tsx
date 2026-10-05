import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, type ReactNode } from 'react';
import { RouterProvider } from 'react-router-dom';
import { ApiError } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './components/Toasts';
import { useConfig } from './api/queries';
import { PageSpinner } from './components/States';
import { setMoneyFormat } from './lib/format';
import { createRouter } from './routes';
import { WalletProvider } from './wallet/WalletContext';

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
    },
  });
}

/** Loads the payments mode (bank or chain) once, so every amount renders with the right currency on first paint. */
function ConfigGate({ children }: { children: ReactNode }): JSX.Element {
  const q = useConfig();
  const cfg = q.data;
  if (cfg) setMoneyFormat({ mode: cfg.paymentsMode, symbol: cfg.currencySymbol, code: cfg.currencyCode });
  useEffect(() => {
    // Keep the format in step if the config refetches.
    if (cfg) setMoneyFormat({ mode: cfg.paymentsMode, symbol: cfg.currencySymbol, code: cfg.currencyCode });
  }, [cfg]);
  if (q.isPending) return <PageSpinner label="Starting StreamVerse" />;
  return <>{children}</>;
}

export default function App(): JSX.Element {
  const client = useMemo(makeClient, []);
  const router = useMemo(createRouter, []);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ConfigGate>
          <AuthProvider>
            <WalletProvider>
              <RouterProvider router={router} />
            </WalletProvider>
          </AuthProvider>
        </ConfigGate>
      </ToastProvider>
    </QueryClientProvider>
  );
}
