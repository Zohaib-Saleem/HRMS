// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The bell: a count, a list, and each notification opening what it is about.
 *
 * An attendance correction and an asset issue both arrive with their facts on
 * separate lines; those lines must survive into the dropdown, and the item must
 * open the exact request or issue it names.
 */

/*
 * Floating UI, which positions the Radix popover, asks every element whether it
 * is in the top layer with `matches(':popover-open')` and `matches(':modal')`.
 * jsdom's selector engine answers those two pseudo-classes in tens of seconds,
 * all synchronously, so the panel appeared ~40s after the click. Nothing here
 * is in the top layer; every other selector still reaches jsdom.
 */
const nativeMatches = Element.prototype.matches;
beforeAll(() => {
  Element.prototype.matches = function (this: Element, selector: string) {
    if (selector === ':popover-open' || selector === ':modal') return false;
    return nativeMatches.call(this, selector);
  };
});
afterAll(() => {
  Element.prototype.matches = nativeMatches;
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { NotificationCenter, notificationLink } = await import('./notification-center');

const CORRECTION = {
  id: 'n-1',
  type: 'APPROVAL_REQUESTED',
  title: 'Attendance Correction Request',
  message: [
    'Employee: Hassan Ali',
    'Date: 05-Oct-2026',
    'Correction: Missing check-out',
    'Current: Missing',
    'Requested: 06:02 PM',
    'Reason: Forgot to punch out',
  ].join('\n'),
  entityType: 'ApprovalRequest',
  entityId: 'appr-77',
  readAt: null,
  createdAt: '2026-10-05T13:10:00.000Z',
};

const ISSUE = {
  id: 'n-2',
  type: 'SYSTEM',
  title: 'Asset Issue Reported',
  message: 'Employee: Ahmed Khan\nAsset: Dell Latitude\nAsset Tag: IT-LAP-0042\nIssue: Charger does not work',
  entityType: 'AssetIncident',
  entityId: 'incident-9',
  readAt: null,
  createdAt: '2026-10-05T13:00:00.000Z',
};

function serve() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
      const body =
        path === '/notifications/unread-count'
          ? { data: { count: 2 } }
          : path === '/notifications'
            ? { data: [CORRECTION, ISSUE], meta: { page: 1, limit: 12, total: 2, totalPages: 1 } }
            : init?.method === 'POST'
              ? { data: { ok: true } }
              : { data: null };
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body)),
      } as Response);
    }),
  );
}

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<NotificationCenter />} />
          <Route path="/approvals/:id" element={<p>Approval page</p>} />
          <Route path="/assets/issues" element={<p>Issue queue</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Opens the popover with a plain click event; Radix toggles on it. */
function open(trigger: HTMLElement) {
  fireEvent.click(trigger);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('where a notification leads', () => {
  it('maps each kind to its page', () => {
    expect(notificationLink({ entityType: 'ApprovalRequest', entityId: 'a1' })).toEqual({
      to: '/approvals/a1',
      label: 'Review request',
    });
    expect(notificationLink({ entityType: 'AssetIncident', entityId: 'i1' })).toEqual({
      to: '/assets/issues?issue=i1',
      label: 'View issue',
    });
    expect(notificationLink({ entityType: 'Asset', entityId: 'x' })?.to).toBe('/assets/x');
    expect(notificationLink({ entityType: 'Case', entityId: 'c' })?.to).toBe('/cases/c');
    expect(notificationLink({ entityType: 'Unknown', entityId: 'u' })).toBeNull();
    expect(notificationLink({ entityType: 'ApprovalRequest', entityId: null })).toBeNull();
  });
});

describe('the dropdown', () => {
  it('shows the badge count and every line of a correction, with Review request', async () => {
    serve();
    renderBell();

    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    open(bell);

    const message = await screen.findByText(/Employee: Hassan Ali/);
    expect(message.className).toContain('whitespace-pre-line');
    expect(message.textContent).toBe(CORRECTION.message);
    expect(screen.getByText('Review request →')).toBeInTheDocument();
    expect(screen.getByText('View issue →')).toBeInTheDocument();
  });

  it('a correction opens its exact approval', async () => {
    serve();
    renderBell();
    open(await screen.findByRole('button', { name: /Notifications/ }));
    fireEvent.click(await screen.findByText(/Employee: Hassan Ali/));

    await waitFor(() => expect(screen.getByText('Approval page')).toBeInTheDocument());
  });

  it('an asset issue opens the issue queue on that issue', async () => {
    serve();
    renderBell();
    open(await screen.findByRole('button', { name: /Notifications/ }));
    fireEvent.click(await screen.findByText(/Employee: Ahmed Khan/));

    await waitFor(() => expect(screen.getByText('Issue queue')).toBeInTheDocument());
  });
});
