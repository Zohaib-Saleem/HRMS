import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Permission, SessionContext as SessionPayload } from '@hrms/shared';
import { ApiError, api } from '@/lib/api';

interface SessionValue {
  session: SessionPayload | null;
  permissions: Set<Permission>;
  isLoading: boolean;
  error: unknown;
  /** True for a genuine failure, false when simply signed out. */
  isError: boolean;
  refetch: () => Promise<unknown>;
  /** Drops every cached query - call after sign-out. */
  clear: () => void;
}

const Context = React.createContext<SessionValue | null>(null);

export const SESSION_QUERY_KEY = ['session'] as const;

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: () => api.get<SessionPayload>('/me'),
    // A 401 here is the normal signed-out state, not a failure worth retrying.
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.isUnauthorized) return false;
      return failureCount < 2;
    },
    staleTime: 60_000,
  });

  const value = React.useMemo<SessionValue>(() => {
    const signedOut = query.error instanceof ApiError && query.error.isUnauthorized;
    return {
      session: query.data ?? null,
      permissions: new Set(query.data?.permissions ?? []),
      isLoading: query.isLoading,
      error: query.error,
      isError: query.isError && !signedOut,
      refetch: query.refetch,
      clear: () => {
        queryClient.setQueryData(SESSION_QUERY_KEY, undefined);
        queryClient.clear();
      },
    };
  }, [query, queryClient]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): SessionValue {
  const context = React.useContext(Context);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>.');
  return context;
}

/** Throws if called outside an authenticated route - keeps screens null-free. */
export function useAuthenticatedSession(): SessionPayload {
  const { session } = useSession();
  if (!session) throw new Error('No active session. Render this inside a protected route.');
  return session;
}

export function usePermissions() {
  const { permissions } = useSession();
  return React.useMemo(
    () => ({
      has: (permission: Permission) => permissions.has(permission),
      hasAny: (...list: Permission[]) => list.some((p) => permissions.has(p)),
      hasAll: (...list: Permission[]) => list.every((p) => permissions.has(p)),
    }),
    [permissions],
  );
}

interface CanProps {
  /** Passes when the user holds every listed permission. */
  permission: Permission | Permission[];
  /** Switches to "any of" matching. */
  mode?: 'all' | 'any';
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Hides UI the user cannot act on.
 *
 * This is a courtesy, not a security control - the API enforces the same
 * permission on every route.
 */
export function Can({ permission, mode = 'all', fallback = null, children }: CanProps) {
  const { permissions } = useSession();
  const list = Array.isArray(permission) ? permission : [permission];
  const allowed =
    mode === 'any' ? list.some((p) => permissions.has(p)) : list.every((p) => permissions.has(p));
  return <>{allowed ? children : fallback}</>;
}
