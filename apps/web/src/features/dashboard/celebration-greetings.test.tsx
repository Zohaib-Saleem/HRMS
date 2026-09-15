// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  MOMENT_GREETING_SUGGESTIONS,
  type BirthdayMoment,
  type CompanyMomentsView,
} from '@hrms/shared';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, post: vi.fn() } };
});

import { ApiError, api } from '@/lib/api';
import { CompanyMoments } from './company-moments';

/**
 * Greeting the colleague on the celebration card.
 *
 * The dashboard could already tell an employee whose birthday it was and give
 * them no way to say so. These cases pin the path from seeing to saying, and
 * the three things about it that are easy to get wrong later:
 *
 *   1. The dialog opens on a real, sendable sentence. The suggestions exist
 *      because an empty box is the reason a greeting never gets sent, and a
 *      suggestion that only *offers* text rather than filling the box in is
 *      back to an empty box with extra steps.
 *   2. What is sent is what the sender saw. A suggestion can be edited, and
 *      the edited text is the payload - the picked suggestion is not smuggled
 *      through underneath.
 *   3. A person already greeted shows a state, not a button. The server owns
 *      that fact (`greetedByMe`), so it survives a refresh rather than living
 *      in a component that forgets on reload.
 */

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const post = vi.mocked(api.post);

const person = (over: Partial<BirthdayMoment> & { employeeId: string }): BirthdayMoment => ({
  fullName: 'Ayesha Khan',
  photoUrl: null,
  departmentName: 'Engineering',
  teamName: 'Platform',
  designationName: 'Engineer',
  greetedByMe: false,
  greetingCount: 0,
  ...over,
});

const moments = (over: Partial<CompanyMomentsView> = {}): CompanyMomentsView => ({
  birthdays: [],
  anniversaries: [],
  newJoiners: [],
  ...over,
});

const view = (value: CompanyMomentsView) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CompanyMoments moments={value} companyName="Example Ltd" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

/** The open greeting dialog. */
const dialog = () => screen.getByRole('dialog');

// ------------------------------------------------------------ the row control

describe('the greet control on a celebration row', () => {
  it('offers to greet a colleague whose birthday it is', () => {
    view(moments({ birthdays: [person({ employeeId: 'a' })] }));
    expect(screen.getByRole('button', { name: 'Greet' })).toBeInTheDocument();
  });

  it('shows that you have already greeted them, with no second button', () => {
    view(moments({ birthdays: [person({ employeeId: 'a', greetedByMe: true, greetingCount: 1 })] }));

    expect(screen.getByText('Greeted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Greet' })).not.toBeInTheDocument();
  });

  it('counts the colleagues who have greeted them', () => {
    view(moments({ birthdays: [person({ employeeId: 'a', greetingCount: 4 })] }));
    expect(screen.getByTitle('4 greetings')).toBeInTheDocument();
  });

  it('says nothing at all when nobody has greeted them yet', () => {
    // "0 greetings" under a birthday card announces that nobody remembered,
    // which is the opposite of what the block is for.
    view(moments({ birthdays: [person({ employeeId: 'a', greetingCount: 0 })] }));
    expect(screen.queryByTitle(/greeting/)).not.toBeInTheDocument();
  });

  it('offers to greet on every kind of celebration, not only birthdays', () => {
    view(
      moments({
        anniversaries: [{ ...person({ employeeId: 'b', fullName: 'Kaleem Maqbool' }), years: 5 }],
        newJoiners: [
          {
            ...person({ employeeId: 'c', fullName: 'Noor Fatima' }),
            hireDate: '2026-09-14',
            workingDay: 2,
          },
        ],
      }),
    );

    expect(screen.getAllByRole('button', { name: 'Greet' })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- the dialog

describe('the greeting dialog', () => {
  const openFor = async (value: CompanyMomentsView) => {
    const user = userEvent.setup();
    view(value);
    await user.click(screen.getAllByRole('button', { name: 'Greet' })[0]!);
    return user;
  };

  it('opens on a sendable greeting rather than an empty box', async () => {
    await openFor(moments({ birthdays: [person({ employeeId: 'a' })] }));

    const box = within(dialog()).getByLabelText('Your greeting');
    expect(box).toHaveValue(MOMENT_GREETING_SUGGESTIONS.BIRTHDAY[0]);
  });

  it('offers every suggestion for the occasion', async () => {
    await openFor(moments({ birthdays: [person({ employeeId: 'a' })] }));

    // By role, not by text: the first suggestion is also sitting in the
    // textarea, and a chip is a button while the draft is not.
    for (const suggestion of MOMENT_GREETING_SUGGESTIONS.BIRTHDAY) {
      expect(within(dialog()).getByRole('button', { name: suggestion })).toBeInTheDocument();
    }
  });

  it('offers the occasion\'s own suggestions, not the birthday ones', async () => {
    await openFor(
      moments({
        newJoiners: [
          {
            ...person({ employeeId: 'c', fullName: 'Noor Fatima' }),
            hireDate: '2026-09-14',
            workingDay: 2,
          },
        ],
      }),
    );

    const box = within(dialog()).getByLabelText('Your greeting');
    expect(box).toHaveValue(MOMENT_GREETING_SUGGESTIONS.NEW_JOINER[0]);
  });

  it('puts a chosen suggestion into the box, where it can still be edited', async () => {
    const user = await openFor(moments({ birthdays: [person({ employeeId: 'a' })] }));
    const third = MOMENT_GREETING_SUGGESTIONS.BIRTHDAY[2]!;

    await user.click(within(dialog()).getByRole('button', { name: third }));
    expect(within(dialog()).getByLabelText('Your greeting')).toHaveValue(third);
  });

  it('sends the greeting for the right person and occasion', async () => {
    post.mockResolvedValue({ id: 'g-1', greetingCount: 1 } as never);
    const user = await openFor(moments({ birthdays: [person({ employeeId: 'emp-7' })] }));

    await user.click(screen.getByRole('button', { name: 'Send greeting' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/me/company-moments/greetings', {
        employeeId: 'emp-7',
        occasion: 'BIRTHDAY',
        message: MOMENT_GREETING_SUGGESTIONS.BIRTHDAY[0],
      }),
    );
  });

  it('sends what the sender typed, not the suggestion underneath it', async () => {
    post.mockResolvedValue({ id: 'g-1', greetingCount: 1 } as never);
    const user = await openFor(moments({ birthdays: [person({ employeeId: 'emp-7' })] }));

    const box = within(dialog()).getByLabelText('Your greeting');
    await user.clear(box);
    await user.type(box, 'Happy birthday Ayesha, from the whole team!');
    await user.click(screen.getByRole('button', { name: 'Send greeting' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/me/company-moments/greetings',
        expect.objectContaining({ message: 'Happy birthday Ayesha, from the whole team!' }),
      ),
    );
  });

  it('will not send an empty greeting', async () => {
    const user = await openFor(moments({ birthdays: [person({ employeeId: 'a' })] }));

    await user.clear(within(dialog()).getByLabelText('Your greeting'));

    expect(screen.getByRole('button', { name: 'Send greeting' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('closes once the greeting is away', async () => {
    post.mockResolvedValue({ id: 'g-1', greetingCount: 1 } as never);
    const user = await openFor(moments({ birthdays: [person({ employeeId: 'a' })] }));

    await user.click(screen.getByRole('button', { name: 'Send greeting' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('stays open with the draft intact when the server refuses', async () => {
    // The server refuses a second greeting for the same occasion. Closing the
    // dialog here would throw away what the sender wrote for no reason they
    // could see.
    post.mockRejectedValue(
      new ApiError(409, { code: 'CONFLICT', message: 'You have already greeted them for this.' }),
    );
    const user = await openFor(moments({ birthdays: [person({ employeeId: 'a' })] }));

    await user.click(screen.getByRole('button', { name: 'Send greeting' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog()).getByLabelText('Your greeting')).toHaveValue(
      MOMENT_GREETING_SUGGESTIONS.BIRTHDAY[0],
    );
  });
});
