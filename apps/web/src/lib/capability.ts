import { useQuery } from '@tanstack/react-query';
import { ApiError, NetworkError } from '@/lib/api';

/**
 * Feature availability, decided by asking the API rather than by a flag.
 *
 * The web app and the API deploy separately, so a screen can ship before the
 * endpoint behind it does. Rather than showing a navigation entry that leads to
 * an error card, the entry is hidden until the endpoint actually answers - and
 * it appears on its own once the API catches up, with no second frontend
 * release.
 *
 * Deliberately not a build-time flag or a version check: both are another thing
 * to remember to change, and both can disagree with what is actually deployed.
 * The endpoint answering is the only evidence that cannot be stale.
 */

export type CapabilityState = 'checking' | 'available' | 'unavailable';

/**
 * How long an answer is trusted before it is asked again.
 *
 * Long enough that navigating around Settings does not re-probe on every tab,
 * short enough that a newly deployed endpoint surfaces within a few minutes
 * without anyone reloading.
 */
export const CAPABILITY_STALE_MS = 5 * 60 * 1000;

/**
 * Turns a query's state into an availability answer.
 *
 * Pending is its own answer rather than "unavailable": showing the entry and
 * then removing it a moment later is worse than waiting, and a failed probe is
 * the only thing that should hide anything.
 *
 * Every failure hides. A 404 means the endpoint is not deployed; a 401 or 403
 * means this user could not use it anyway; a 5xx or a network error means it
 * cannot be relied on right now. In all four cases an entry leading to it is
 * not worth showing, and none of them is worth an error message on a screen the
 * user did not ask for.
 */
export function capabilityFrom(state: {
  isPending: boolean;
  isError: boolean;
}): CapabilityState {
  if (state.isPending) return 'checking';
  return state.isError ? 'unavailable' : 'available';
}

/** True when the failure means "not deployed" rather than "not allowed". */
export function isMissingEndpoint(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** True when the API could not be reached at all. */
export function isUnreachable(error: unknown): boolean {
  return error instanceof NetworkError;
}

/**
 * Probes one endpoint and reports whether it is usable.
 *
 * `retry: false` matters: a missing endpoint is not a transient fault, and
 * retrying a 404 three times on every mount is exactly the hammering this is
 * meant to avoid. The result is cached under the caller's own query key, so a
 * screen that later reads the same endpoint reuses this answer instead of
 * fetching it a second time.
 */
export function useCapability<T>(
  queryKey: readonly unknown[],
  probe: () => Promise<T>,
  options: { enabled?: boolean } = {},
): { state: CapabilityState; data: T | undefined; error: unknown } {
  const query = useQuery({
    queryKey,
    queryFn: probe,
    enabled: options.enabled ?? true,
    retry: false,
    staleTime: CAPABILITY_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return {
    state: options.enabled === false ? 'unavailable' : capabilityFrom(query),
    data: query.data,
    error: query.error,
  };
}
