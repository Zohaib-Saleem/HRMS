import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ApiError } from '@/lib/api';
import { AppErrorBoundary } from '@/app/error-boundary';
import { ThemeProvider, useTheme } from '@/app/theme';
import { AppRoutes } from '@/app/router';
import { SessionProvider, SESSION_QUERY_KEY } from '@/features/auth/session-context';
import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import './index.css';

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      // A session that expired mid-visit should land the user back on login
      // rather than showing an error panel on every screen at once.
      if (
        error instanceof ApiError &&
        error.isUnauthorized &&
        query.queryKey[0] !== SESSION_QUERY_KEY[0]
      ) {
        void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry what will fail identically the second time.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

/** Keeps toast styling in step with the active theme. */
function ThemedToaster() {
  const { resolved } = useTheme();
  return (
    <Toaster
      theme={resolved}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{ duration: 4000 }}
    />
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root was not found in index.html.');

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <ConfirmProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
              <ThemedToaster />
            </ConfirmProvider>
          </SessionProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
