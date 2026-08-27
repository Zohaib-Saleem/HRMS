import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronsLeft, Lock } from 'lucide-react';
import type { Permission } from '@hrms/shared';
import { NAV_SECTIONS, type NavItem } from '@/navigation/nav-config';
import { useSession } from '@/features/auth/session-context';
import { cn } from '@/lib/utils';

/**
 * Sidebar.
 *
 * An item's `permission` array is an ANY-of check: a parent section shows if
 * the user can reach at least one screen beneath it.
 */

function isVisible(item: NavItem, permissions: Set<Permission>): boolean {
  if (!item.permission) return true;
  const list = Array.isArray(item.permission) ? item.permission : [item.permission];
  return list.some((p) => permissions.has(p));
}

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNavigate?: () => void;
}

export function SidebarNav({ collapsed, onToggleCollapsed, onNavigate }: SidebarProps) {
  const { permissions, session } = useSession();
  const location = useLocation();

  const sections = React.useMemo(
    () =>
      NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter((item) => isVisible(item, permissions)),
      })).filter((section) => section.items.length > 0),
    [permissions],
  );

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border',
          collapsed ? 'justify-center px-2' : 'px-4',
        )}
      >
        <span
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-sidebar-active text-sm font-bold text-white"
          aria-hidden
        >
          H
        </span>
        {!collapsed ? (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight text-white">HRMS</p>
            <p className="truncate text-[11px] leading-tight text-sidebar-muted">
              {session?.company.name ?? 'Workspace'}
            </p>
          </div>
        ) : null}
      </div>

      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2.5 py-4" aria-label="Main">
        {sections.map((section) => (
          <div key={section.key}>
            {section.label && !collapsed ? (
              <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-sidebar-muted">
                {section.label}
              </p>
            ) : null}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavItemLink
                    item={item}
                    collapsed={collapsed}
                    currentPath={location.pathname}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
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
  currentPath: string;
  onNavigate?: () => void;
}

function NavItemLink({ item, collapsed, currentPath, onNavigate }: NavItemLinkProps) {
  const Icon = item.icon;
  const planned = item.status === 'planned';

  const active = item.matchPrefix
    ? currentPath === item.to || currentPath.startsWith(`${item.to}/`)
    : currentPath === item.to;

  const base = cn(
    'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors',
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
