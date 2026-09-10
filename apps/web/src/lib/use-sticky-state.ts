import * as React from 'react';

/**
 * State that survives a reload, kept in `localStorage`.
 *
 * For preferences a reader would be annoyed to set twice - which view of a
 * screen they were on, which tab was open. Never for data: nothing here is
 * authoritative, and a value that fails to load is simply the fallback.
 *
 * Every read and write is guarded. `localStorage` throws outright in a browser
 * configured to block site data and in some embedded webviews, and a preference
 * is never worth taking a page down for. An unrecognised stored value - an
 * option that has since been renamed or removed - falls back too, so a stale
 * entry cannot select a view that no longer exists.
 */
export function useStickyState<T extends string>(
  key: string,
  fallback: T,
  allowed: ReadonlyArray<T>,
): [T, (next: T) => void] {
  const [value, setValue] = React.useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null && (allowed as ReadonlyArray<string>).includes(stored)
        ? (stored as T)
        : fallback;
    } catch {
      return fallback;
    }
  });

  const set = React.useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // A preference that cannot be remembered is not an error worth showing.
      }
    },
    [key],
  );

  return [value, set];
}
