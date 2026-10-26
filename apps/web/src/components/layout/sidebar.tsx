import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronsLeft, Lock, Search, X } from 'lucide-react';
import {
  activeNavPath,
  navModeFor,
  navigationFor,
  type NavItem,
  type NavSection,
} from '@/navigation/nav-config';
import { useFoldedSections, useShowSelfService } from '@/navigation/nav-preferences';
import { useSession } from '@/features/auth/session-context';
import { useMedicalHiddenFromMenu } from '@/features/medical/use-medical-hidden';
import { cn } from '@/lib/utils';

/**
 * Sidebar.
 *
 * Which rows, in which groups, is decided by `navigationFor` from the user's
 * grants - see nav-config. An item's `permission` array is an ANY-of check.
 * This component only draws the result: groups that fold, a filter that finds
 * a page by name, and one highlighted row.
 */

/** The id the header's search button and Ctrl K focus. */
export const NAV_FILTER_ID = 'hrms-nav-filter';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNavigate?: () => void;
}

export function SidebarNav({ collapsed, onToggleCollapsed, onNavigate }: SidebarProps) {
  const { permissions, session } = useSession();
  const location = useLocation();
  // Not a permission: an employee the medical benefit does not reach holds
  // medical.read like everybody else, and is simply not shown the entry.
  const medicalHidden = useMedicalHiddenFromMenu();
  const [showSelfService] = useShowSelfService(session?.user?.id);
  const [folded, toggleFolded] = useFoldedSections();
  const [query, setQuery] = React.useState('');

  const mode = navModeFor(permissions);

  const sections = React.useMemo(
    () =>
      navigationFor(permissions, {
        showSelfService,
        hide: (item) => medicalHidden && item.to === '/medical',
      }),
    [permissions, medicalHidden, showSelfService],
  );

  const activePath = activeNavPath(sections, location.pathname);

  const needle = query.trim().toLowerCase();
  const shown: NavSection[] = needle
    ? sections
        .map((s) => ({
          ...s,
          items: s.items.filter((i) => i.label.toLowerCase().includes(needle)),
        }))
        .filter((s) => s.items.length > 0)
    : sections;

  const roleName = session?.user?.roles?.[0]?.name;

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div
        className={cn(
          'flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border',
          collapsed ? 'justify-center px-2' : 'px-4',
        )}
      >
        <span
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-sidebar-active text-[13px] font-bold tracking-tight text-white shadow-sm"
          aria-hidden
        >
          HR
        </span>
        {!collapsed ? (
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-[15px] font-semibold leading-tight text-white">
              <span>HRMS</span>
              {roleName && mode === 'administration' ? (
                <span className="truncate rounded-md bg-sidebar-badge px-1.5 py-px text-[10px] font-semibold text-sidebar-badge-foreground">
                  {roleName}
                </span>
              ) : null}
            </p>
            <p className="truncate text-[11.5px] leading-tight text-sidebar-muted">
              {session?.company.name ?? 'Workspace'}
            </p>
          </div>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="shrink-0 px-3 pt-3">
          <label className="relative block">
            <span className="sr-only">Find a page</span>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-sidebar-muted"
              aria-hidden
            />
            <input
              id={NAV_FILTER_ID}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
              }}
              placeholder="Find a page"
              autoComplete="off"
              className="h-8 w-full rounded-md border border-sidebar-border bg-sidebar-accent/60 pl-8 pr-7 text-[12.5px] text-white placeholder:text-sidebar-muted focus:border-sidebar-active focus:outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-sidebar-muted hover:text-white"
                aria-label="Clear filter"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </label>
        </div>
      ) : null}

      <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3" aria-label="Main">
        {shown.length === 0 ? (
          <p className="px-2.5 py-4 text-[12.5px] text-sidebar-muted">No page matches “{query}”.</p>
        ) : null}
        {shown.map((section, index) => {
          // A filter shows every match, folded or not.
          const isFolded = !needle && !collapsed && !!section.label && folded.has(section.key);
          const listId = `nav-section-${section.key}`;
          return (
            <div
              key={section.key}
              className={cn(index > 0 && 'mt-2 border-t border-sidebar-border/70 pt-2')}
            >
              {section.label && !collapsed ? (
                <button
                  type="button"
                  onClick={() => toggleFolded(section.key)}
                  aria-expanded={!isFolded}
                  aria-controls={listId}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wider text-sidebar-muted transition-colors hover:text-white"
                >
                  <span className="flex-1 truncate">{section.label}</span>
                  <ChevronDown
                    className={cn('size-3.5 shrink-0 transition-transform', isFolded && '-rotate-90')}
                    aria-hidden
                  />
                </button>
              ) : null}
              {!isFolded ? (
                <ul id={listId} className="space-y-0.5">
                  {section.items.map((item) => (
                    <li key={item.to}>
                      <NavItemLink
                        item={item}
                        collapsed={collapsed}
                        active={item.to === activePath}
                        onNavigate={onNavigate}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-sidebar-border p-2.5">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className={cn(
            'hidden w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground lg:flex',
            collapsed && 'justify-center px-0',
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronsLeft
            className={cn('size-4 shrink-0 transition-transform', collapsed && 'rotate-180')}
            aria-hidden
          />
          {!collapsed ? <span>Collapse</span> : null}
        </button>
      </div>
    </div>
  );
}

interface NavItemLinkProps {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
  onNavigate?: () => void;
}

function NavItemLink({ item, collapsed, active, onNavigate }: NavItemLinkProps) {
  const Icon = item.icon;
  const planned = item.status === 'planned';

  const base = cn(
    'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] font-medium transition-colors',
    collapsed && 'justify-center px-0',
  );

  if (planned) {
    return (
      <span
        className={cn(base, 'cursor-not-allowed text-sidebar-muted/70')}
        title={`${item.label} - coming in a later phase`}
        aria-disabled
      >
        <Icon className="size-4.5 shrink-0" aria-hidden />
        {!collapsed ? (
          <>
            <span className="flex-1 truncate">{item.label}</span>
            {item.badge ? (
              <span className="rounded bg-sidebar-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                {item.badge}
              </span>
            ) : (
              <Lock className="size-3.5 opacity-60" aria-hidden />
            )}
          </>
        ) : null}
      </span>
    );
  }

  return (
    <NavLink
      to={item.to}
      end={!item.matchPrefix}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-current={active ? 'page' : false}
      className={cn(
        base,
        active
          ? 'bg-sidebar-active text-white shadow-sm'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-white',
      )}
    >
      <Icon className="size-4.5 shrink-0" aria-hidden />
      {!collapsed ? <span className="flex-1 truncate">{item.label}</span> : null}
    </NavLink>
  );
}
