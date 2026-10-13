// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * Where a clicked browser push lands: /notifications/<id>.
 *
 * The id came from outside the app, so it is not trusted to mean anything
 * until the server has said it is the signed-in person's own notification.
 * Only then does the page go to the record - and the record's own screen
 * still checks access, which is not this page's job.
 */

const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', async (load) => ({ ...(await load<typeof import('@/lib/api')>()), api }));

const { NotificationOpenPage } = await import('./notification-open-page');

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/notifications/:id" element={<NotificationOpenPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const RECORD = {
  id: 'n-1',
  type: 'CASE_UPDATE',
  title: 'Case CASE-2026-000020 assigned to you',
  message: 'Laptop is not working',
  entityType: 'CaseDesk',
  entityId: 'case-20',
  readAt: null,
  createdAt: '2026-10-13T10:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue({});
});
afterEach(cleanup);

describe('opening a clicked push', () => {
  it("reads the caller's own notification, marks it read, and opens the exact record", async () => {
    api.get.mockResolvedValue(RECORD);
    renderAt('/notifications/n-1');

    expect(await screen.findByTestId('where')).toHaveTextContent('/case-queue/case-20');
    expect(api.get).toHaveBeenCalledWith('/notifications/n-1');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/notifications/n-1/read'));
  });

  it("goes nowhere for somebody else's notification", async () => {
    api.get.mockRejectedValue(new ApiError(404, { code: 'NOT_FOUND', message: 'Notification not found' }));
    renderAt('/notifications/n-1');

    expect(await screen.findByText('This notification is not available')).toBeInTheDocument();
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows a notification that has nothing to open, such as the test one', async () => {
    api.get.mockResolvedValue({ ...RECORD, title: 'HRMS notifications are on', entityType: 'PushTest', entityId: null });
    renderAt('/notifications/n-1');

    expect(await screen.findByText('HRMS notifications are on')).toBeInTheDocument();
  });
});
