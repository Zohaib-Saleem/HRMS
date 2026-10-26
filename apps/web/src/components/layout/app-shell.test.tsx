// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Permission, SessionContext } from '@hrms/shared';
import { PERMISSIONS } from '@hrms/shared';

/**
 * The shell's scroll contract.
 *
 * One property, stated four ways: the DOCUMENT never scrolls. The shell claims
 * the viewport and hides its own overflow, so the only vertical scrollport on
 * a desktop page is `<main>`, and the sidebar and header - which sit outside
 * it - cannot be carried off the top of the screen by a long page. This was a
 * real defect: the sidebar was a `sticky` element inside a column that was
 * exactly as tall as the viewport, which gave it no room to stick within, so
 * it travelled with the document like any static box.
 *
 * jsdom does not lay anything out, so these are assertions about which element
 * is declared the scrollport and where the sidebar sits relative to it - the
 * structure that makes the layout work, rather than the pixels it produces.
 * The pixels are checked in a browser separately.
 */

const session: SessionContext = {
  user: {
    id: 'u1',
    email: 'shell@example.test',
    firstName: 'Shell',
    lastName: 'User',
    fullName: 'Shell User',
    status: 'ACTIVE',
    mustChangePassword: false,
    lastLoginAt: null,
    avatarColor: '#4f46e5',
    roles: [{ id: 'r1', key: 'super_admin', name: 'Super Admin' }],
    employee: {
      id: 'e1',
      employeeNumber: '001',
      jobTitle: 'Engineer',
      departmentName: 'Engineering',
      teamName: 'Platform',
      photoUrl: null,
    },
  },
  company: {
    id: 'c1',
    name: 'Layout Co',
    timezone: 'UTC',
    currency: 'USD',
    dateFormat: 'dd/MM/yyyy',
    weekStartsOn: 'MONDAY',
  },
  permissions: Object.values(PERMISSIONS) as Permission[],
  dataScope: 'ALL',
  employeeLinked: true,
};

vi.mock('@/features/auth/session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/session-context')>();
  // Read inside the hooks, never in the factory: the factory runs before this
  // file's own body has been evaluated.
  const permissionSet = () => new Set(session.permissions);
  return {
    ...actual,
    useSession: () => ({
      session,
      permissions: permissionSet(),
      isLoading: false,
      error: null,
      isError: false,
      refetch: vi.fn(),
      clear: vi.fn(),
    }),
    usePermissions: () => {
      const permissions = permissionSet();
      return {
        has: (p: Permission) => permissions.has(p),
        hasAny: (...list: Permission[]) => list.some((p) => permissions.has(p)),
        hasAll: (...list: Permission[]) => list.every((p) => permissions.has(p)),
      };
    },
  };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockResolvedValue({ count: 0 }),
      getPage: vi.fn().mockResolvedValue({ data: [], meta: { page: 1, limit: 12, total: 0, totalPages: 1 } }),
      post: vi.fn(),
    },
  };
});

// jsdom has no media query engine; the theme provider asks it for the OS
// preference on mount.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

import { ThemeProvider } from '@/app/theme';
import { ConfirmProvider } from '@/components/feedback/confirm-dialog';
import { AppShell } from './app-shell';

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/attendance']}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/attendance" element={<p>A very long page</p>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

/** The shell's outermost box - the one that either scrolls or does not. */
function shellRoot(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe('app shell scrolling', () => {
  it('claims the viewport and hides its own overflow, so the document cannot scroll', () => {
    const { container } = renderShell();
    const root = shellRoot(container);

    expect(root).toHaveClass('h-dvh');
    expect(root).toHaveClass('overflow-hidden');
  });

  it('makes <main> the page scrollport, and lets it shrink inside the flex column', () => {
    renderShell();
    const main = screen.getByRole('main');

    expect(main).toHaveClass('overflow-y-auto');
    // Without `min-h-0` a flex child refuses to shrink below its content, which
    // pushes the shell past the viewport and hands the scroll back to the page.
    expect(main).toHaveClass('min-h-0');
    // The spacing the pages are written against stays on the scrollport.
    expect(main.className).toMatch(/px-4/);
    expect(main.className).toMatch(/py-6/);
  });

  it('keeps the sidebar and the header outside the scrollport', () => {
    const { container } = renderShell();
    const main = screen.getByRole('main');
    const aside = container.querySelector('aside') as HTMLElement;
    const header = container.querySelector('header') as HTMLElement;

    // Anything inside <main> scrolls with the page. These two must not be.
    expect(main.contains(aside)).toBe(false);
    expect(main.contains(header)).toBe(false);
    expect(aside.contains(main)).toBe(false);
  });

  it('gives the sidebar the full height of the shell and its own internal scroll', () => {
    const { container } = renderShell();
    const aside = container.querySelector('aside') as HTMLElement;

    expect(aside).toHaveClass('h-full');
    // A nav taller than the viewport scrolls inside itself, not the page.
    const nav = within(aside).getByRole('navigation', { name: 'Main' });
    expect(nav).toHaveClass('overflow-y-auto');
    expect(nav).toHaveClass('min-h-0');
  });

  it('reserves the sidebar width in the flow, so the main column cannot slide under it', () => {
    const { container } = renderShell();
    const aside = container.querySelector('aside') as HTMLElement;
    const root = shellRoot(container);

    // A flex row with a non-shrinking sidebar: the main column starts where the
    // sidebar ends. `position: fixed` here would take the sidebar out of the
    // flow and let the content run underneath it.
    expect(root).toHaveClass('flex');
    expect(aside).toHaveClass('shrink-0');
    expect(aside.className).toMatch(/w-64/);
    expect(aside.className).not.toMatch(/\bfixed\b/);
    expect(getComputedStyle(aside).position).not.toBe('fixed');
  });

  it('still opens the navigation as a drawer on a narrow screen', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));

    const drawer = await screen.findByRole('dialog');
    const links = within(drawer).getAllByRole('link');
    expect(links.length).toBeGreaterThan(3);
  });
});
