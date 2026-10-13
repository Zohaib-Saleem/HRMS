import * as React from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronRight, Menu, Search } from 'lucide-react';
import { NAV_SECTIONS, ROUTE_TITLES } from '@/navigation/nav-config';
import { SidebarNav } from './sidebar';
import { UserMenu } from './user-menu';
import { NotificationCenter } from '@/features/notifications/notification-center';
import { cn } from '@/lib/utils';
import { onPushClick, syncPush } from '@/lib/push';
import { BreadcrumbTitleProvider } from './breadcrumb-title';

const COLLAPSE_KEY = 'hrms.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Application shell: fixed sidebar, fixed top bar, scrollable content column.
 *
 * The shell owns the viewport (`h-dvh` + `overflow-hidden`), so the document
 * itself never scrolls. The only vertical scrollport on desktop is `<main>`;
 * the sidebar and header sit outside it and therefore stay put. A sidebar with
 * more nav than fits scrolls inside its own `<nav>`, not the page.
 *
 * Below `lg` the sidebar becomes a drawer.
 */
export function AppShell() {
  const [collapsed, setCollapsed] = React.useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const location = useLocation();
  /** What the current page calls itself, for the last breadcrumb. */
  const [leafTitle, setLeafTitle] = React.useState<string | null>(null);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // Preference will not persist; layout still works.
      }
      return next;
    });
  }, []);

  const navigate = useNavigate();

  // Browser push: refresh this browser's registration once per visit (never
  // prompts), and route in place when a clicked push focuses this tab.
  React.useEffect(() => {
    void syncPush().catch(() => undefined);
    return onPushClick((path) => navigate(path));
  }, [navigate]);

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => setMobileOpen(false), [location.pathname]);

  // A name belongs to the page that set it. Dropping it on navigation stops the
  // previous record's name sitting in the trail while the next one loads.
  React.useEffect(() => setLeafTitle(null), [location.pathname]);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* Desktop sidebar - full viewport height, outside the scrollport. */}
      <aside
        className={cn(
          'hidden h-full shrink-0 border-r border-sidebar-border transition-[width] duration-200 lg:block',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        <SidebarNav collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </aside>

      {/* Mobile drawer */}
      <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="hrms-overlay fixed inset-0 z-50 bg-black/50 lg:hidden" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-64 outline-none lg:hidden">
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <SidebarNav
              collapsed={false}
              onToggleCollapsed={() => setMobileOpen(false)}
              onNavigate={() => setMobileOpen(false)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/85 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="size-5" />
          </button>

          <Breadcrumbs pathname={location.pathname} leafTitle={leafTitle} />

          <div className="ml-auto flex items-center gap-1.5">
            {/* Reserved for global search - wired up with the People module. */}
            <button
              type="button"
              className="hidden h-9 items-center gap-2 rounded-lg border border-border bg-surface-muted/60 px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent md:flex"
              aria-label="Search (coming soon)"
              disabled
            >
              <Search className="size-4" aria-hidden />
              <span>Search</span>
              <kbd className="ml-3 rounded border border-border bg-surface px-1.5 text-[10px] font-medium">
                Ctrl K
              </kbd>
            </button>

            <NotificationCenter />

            <div className="mx-1 h-6 w-px bg-border" aria-hidden />
            <UserMenu />
          </div>
        </header>

        {/* The page's scrollport. `min-h-0` lets it shrink inside the flex
            column instead of pushing the shell past the viewport. */}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-[1400px]">
            {/*
              Routes are code-split, so the first visit to a screen fetches its
              chunk. The boundary sits inside the shell so the sidebar and
              header stay put while that happens - a navigation should never
              blank the whole page.
            */}
            <React.Suspense fallback={<RouteFallback />}>
              <BreadcrumbTitleProvider setTitle={setLeafTitle}>
                <Outlet />
              </BreadcrumbTitleProvider>
            </React.Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}

/** Quiet placeholder while a route chunk loads. Matches a page header block. */
function RouteFallback() {
  return (
    <div className="animate-pulse space-y-4" aria-busy role="status" aria-label="Loading">
      <div className="h-7 w-56 rounded-md bg-muted" />
      <div className="h-4 w-80 rounded-md bg-muted" />
      <div className="h-64 rounded-xl bg-muted" />
    </div>
  );
}

/** Derives the trail from the nav registry, so it never drifts from routing. */
function Breadcrumbs({ pathname, leafTitle }: { pathname: string; leafTitle: string | null }) {
  const segments = pathname.split('/').filter(Boolean);

  const trail = segments.map((_, index) => {
    const to = `/${segments.slice(0, index + 1).join('/')}`;
    const fromNav = NAV_SECTIONS.flatMap((s) => s.items).find((item) => item.to === to)?.label;
    const registered = ROUTE_TITLES[to] ?? fromNav;
    // The page's own name is only consulted for the LAST crumb, and only when
    // the registry has nothing - a real route title always wins.
    const named = registered ?? (index === segments.length - 1 ? leafTitle : null);
    const label = named ?? to.split('/').pop()?.replace(/-/g, ' ') ?? 'Page';
    // An id read as a word under `capitalize`; a name must not be re-cased.
    return { to, label, isName: named !== null && registered === undefined };
  });

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px]">
      <Link
        to="/"
        className={cn(
          'shrink-0 transition-colors hover:text-foreground',
          trail.length === 0 ? 'font-medium text-foreground' : 'text-muted-foreground',
        )}
      >
        Dashboard
      </Link>
      {trail.map((crumb, index) => (
        <React.Fragment key={crumb.to}>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
          {index === trail.length - 1 ? (
            <span
              className={cn('truncate font-medium', !crumb.isName && 'capitalize')}
              aria-current="page"
            >
              {crumb.label}
            </span>
          ) : (
            <Link
              to={crumb.to}
              className="truncate capitalize text-muted-foreground transition-colors hover:text-foreground"
            >
              {crumb.label}
            </Link>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}
