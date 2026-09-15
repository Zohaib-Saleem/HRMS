// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The photo management dialog.
 *
 * Four actions, and the screen has to be honest about all of them: see the
 * photo on file, put a different one up, take it down, or leave without
 * changing anything. The last is the one worth guarding - a dialog that uploads
 * on file-pick gives no way back.
 *
 * The two client-side checks are asserted here because they are what the user
 * actually experiences: a 12 MB photo should be refused before the upload
 * starts, not after it. They are a courtesy, not the control - the API makes
 * the same two decisions against the bytes it receives, which is what
 * `employee-photo.routes.test.ts` holds down.
 */

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { upload: vi.fn(), delete: vi.fn() },
  };
});

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

import { api } from '@/lib/api';
import { EmployeePhotoDialog } from './employee-photo-dialog';

const EMPLOYEE_ID = 'emp-1';
const NAME = 'Muhammad AbuBakar';
const STORED_PHOTO = '/api/v1/employees/emp-1/photo?v=2026-09-14T00%3A00%3A00.000Z';

/** A file of a given type and size, without allocating the bytes for real. */
function fileOf(name: string, type: string, size = 1024): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function renderDialog(props: Partial<React.ComponentProps<typeof EmployeePhotoDialog>> = {}) {
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EmployeePhotoDialog
        open
        onOpenChange={onOpenChange}
        employeeId={EMPLOYEE_ID}
        employeeName={NAME}
        photoUrl={null}
        hasPhoto={false}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

const fileInput = () => screen.getByTestId('employee-photo-input') as HTMLInputElement;

/**
 * Picks a file, as the file dialog would.
 *
 * `applyAccept: false` is deliberate for the rejection cases below. The input's
 * `accept` attribute already filters the picker, and testing-library honours it
 * - so a file that fails `accept` never reaches the change handler and the
 * check under test is never run. Switching it off is how a file that DID get
 * through (dropped, renamed, or chosen on a platform whose picker ignores
 * `accept`) is simulated, which is the only case that check exists for.
 */
const pick = (file: File, applyAccept = true) =>
  userEvent.setup({ applyAccept }).upload(fileInput(), file);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.upload).mockResolvedValue({
    photoUrl: STORED_PHOTO,
    hasPhoto: true,
    updatedAt: '2026-09-14T00:00:00.000Z',
  } as never);
  vi.mocked(api.delete).mockResolvedValue({
    photoUrl: null,
    hasPhoto: false,
    updatedAt: null,
  } as never);
  // jsdom does not implement these, and the preview uses both.
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

describe('what the dialog shows', () => {
  it('shows initials and says so when there is no photo yet', () => {
    renderDialog();

    expect(screen.getByText(/No photo yet, so their initials are shown/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload photo/i })).toBeInTheDocument();
    // Nothing to remove, so nothing offering to.
    expect(screen.queryByRole('button', { name: /remove photo/i })).not.toBeInTheDocument();
  });

  it('previews the photo on file and offers to change or remove it', () => {
    renderDialog({ photoUrl: STORED_PHOTO, hasPhoto: true });

    expect(document.querySelector(`img[src="${STORED_PHOTO}"]`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change photo/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove photo/i })).toBeInTheDocument();
  });

  it('states the rules the server enforces', () => {
    renderDialog();

    expect(screen.getByText(/JPG, PNG or WebP, up to 5 MB/)).toBeInTheDocument();
  });
});

describe('uploading', () => {
  it('previews the chosen file and uploads nothing until Save', async () => {
    renderDialog();

    await userEvent.upload(fileInput(), fileOf('me.png', 'image/png'));

    expect(await screen.findByText(/Nothing is saved until you choose Save/)).toBeInTheDocument();
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('posts the file to this employee, and closes', async () => {
    const { onOpenChange } = renderDialog();

    await userEvent.upload(fileInput(), fileOf('me.png', 'image/png'));
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.upload).mock.calls[0]![0]).toBe(`/employees/${EMPLOYEE_ID}/photo`);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toasts.success).toHaveBeenCalledWith('Profile photo updated.');
  });

  it('replaces an existing photo through the same action', async () => {
    renderDialog({ photoUrl: STORED_PHOTO, hasPhoto: true });

    await userEvent.upload(fileInput(), fileOf('new.jpg', 'image/jpeg'));
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
  });

  it('cannot be saved with nothing chosen', () => {
    renderDialog({ photoUrl: STORED_PHOTO, hasPhoto: true });

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('reports what the server refused, and stays open', async () => {
    vi.mocked(api.upload).mockRejectedValue(new Error('That image is larger than 5 MB.'));
    const { onOpenChange } = renderDialog();

    await userEvent.upload(fileInput(), fileOf('me.png', 'image/png'));
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('larger than 5 MB');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('what the browser refuses before uploading', () => {
  it('refuses a file that is not an image, if one gets past the picker', async () => {
    renderDialog();

    await pick(fileOf('resume.pdf', 'application/pdf'), false);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a supported image/i);
    expect(api.upload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses an SVG, which is an image and still not one of ours', async () => {
    renderDialog();

    await pick(fileOf('logo.svg', 'image/svg+xml'), false);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a supported image/i);
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('refuses a file over 5 MB', async () => {
    renderDialog();

    await userEvent.upload(fileInput(), fileOf('huge.jpg', 'image/jpeg', 6 * 1024 * 1024));

    expect(await screen.findByRole('alert')).toHaveTextContent(/larger than 5 MB/i);
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('accepts one just under the limit', async () => {
    renderDialog();

    await userEvent.upload(fileInput(), fileOf('big.jpg', 'image/jpeg', 5 * 1024 * 1024 - 1));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('removing', () => {
  it('removes the photo and closes', async () => {
    const { onOpenChange } = renderDialog({ photoUrl: STORED_PHOTO, hasPhoto: true });

    await userEvent.click(screen.getByRole('button', { name: /remove photo/i }));

    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(`/employees/${EMPLOYEE_ID}/photo`),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toasts.success).toHaveBeenCalledWith('Profile photo removed.');
  });

  it('is not offered for a typed Photo URL, which is not ours to delete', () => {
    // There is a link on the record but no uploaded file behind it.
    renderDialog({ photoUrl: 'https://example.com/legacy.jpg', hasPhoto: false });

    expect(screen.queryByRole('button', { name: /remove photo/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change photo/i })).toBeInTheDocument();
  });
});

describe('cancelling', () => {
  it('closes without sending anything', async () => {
    const { onOpenChange } = renderDialog({ photoUrl: STORED_PHOTO, hasPhoto: true });

    await userEvent.upload(fileInput(), fileOf('me.png', 'image/png'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(api.upload).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });
});
