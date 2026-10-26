import * as React from 'react';

/**
 * Per-browser sidebar preferences: which groups are folded, and whether an
 * administrator wants their own services listed in the sidebar.
 *
 * Conveniences only, so they live in localStorage and every read and write is
 * guarded - a private window or blocked storage gives the defaults, never an
 * error. Shared between the sidebar and the account menu through a window
 * event, so flipping the toggle in one redraws the other.
 */

const SELF_SERVICE_KEY = 'hrms.nav.selfService';
const FOLDED_KEY = 'hrms.nav.folded';
const EVENT = 'hrms:nav-preferences';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preference will not persist; the sidebar still works.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** Keyed by user, so a shared browser does not hand one person's choice to the next. */
export function useShowSelfService(userId: string | undefined): [boolean, (next: boolean) => void] {
  const key = `${SELF_SERVICE_KEY}.${userId ?? 'anon'}`;
  const value = React.useSyncExternalStore(subscribe, () => read(key) === '1');
  const set = React.useCallback((next: boolean) => write(key, next ? '1' : '0'), [key]);
  return [value, set];
}

export function useFoldedSections(): [ReadonlySet<string>, (key: string) => void] {
  const raw = React.useSyncExternalStore(subscribe, () => read(FOLDED_KEY) ?? '');
  const folded = React.useMemo(() => new Set(raw.split(',').filter(Boolean)), [raw]);
  const toggle = React.useCallback(
    (key: string) => {
      const next = new Set(folded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      write(FOLDED_KEY, [...next].join(','));
    },
    [folded],
  );
  return [folded, toggle];
}
