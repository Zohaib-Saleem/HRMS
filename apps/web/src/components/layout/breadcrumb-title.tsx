import * as React from 'react';

/**
 * Lets a detail page name itself in the breadcrumb.
 *
 * The trail is derived from the URL against the nav registry, which is right
 * for every fixed route and useless for the last segment of a record page:
 * `/attendance/team/cmtvd07xy002okfwvvuummt7p` has no entry to find, so the
 * crumb fell back to printing the id. An id is not a place - the reader cannot
 * tell one employee's page from another's by it, and `capitalize` rendered it
 * as a word.
 *
 * The name has to come from the page rather than the shell because only the
 * page has fetched the record. So the shell offers a setter, the page calls
 * this hook once it knows the name, and the crumb uses it in place of the
 * segment. `null` while the record is still loading, which leaves the existing
 * fallback in place rather than blanking the trail.
 */
const BreadcrumbTitleContext = React.createContext<(title: string | null) => void>(() => {});

export function BreadcrumbTitleProvider({
  setTitle,
  children,
}: {
  setTitle: (title: string | null) => void;
  children: React.ReactNode;
}) {
  return (
    <BreadcrumbTitleContext.Provider value={setTitle}>{children}</BreadcrumbTitleContext.Provider>
  );
}

/**
 * Name the current page in the breadcrumb.
 *
 * Cleans up after itself: leaving the page clears the name, so a slow record
 * fetch on the next one cannot briefly show the previous employee's.
 */
export function useBreadcrumbTitle(title: string | null | undefined): void {
  const setTitle = React.useContext(BreadcrumbTitleContext);

  React.useEffect(() => {
    setTitle(title && title.trim() !== '' ? title : null);
    return () => setTitle(null);
  }, [setTitle, title]);
}
