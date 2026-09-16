// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The sidebar an employee actually gets.
 *
 * Driven by `DEFAULT_ROLE_PERMISSIONS.EMPLOYEE` rather than by a hand-written
 * list of grants, which is the whole point: this file fails if somebody changes
 * what the Employee role holds and the navigation stops matching it. A sidebar
 * test against invented permissions proves only that the test agrees with
 * itself.
 *
 * Two things are pinned. WHAT an employee sees - their own screens, and none of
 * the ones that are somebody's job - and the ORDER they see it in, because the
 * order is the fix: this list used to be grouped by module, which put Approvals
 * and Device punches above the employee's own attendance and leave.
 *
 * Hiding a row is not a permission change and must never be mistaken for one.
 * Every endpoint behind every entry here is gated on the server exactly as it
 * was; what changed is which signposts an employee is made to read past.
 */

let permissions = new Set<Permission>();

vi.mock('@/features/auth/session-context', () => ({
  useSession: () => ({
    permissions,
    session: { company: { name: 'Example Ltd' } },
  }),
}));

import { SidebarNav } from '@/components/layout/sidebar';
import { NAV_SECTIONS } from './nav-config';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The sidebar as a signed-in user with exactly these grants would see it. */
function sidebarFor(grants: readonly Permission[]): string[] {
  permissions = new Set(grants);
  render(
    <MemoryRouter>
      <SidebarNav collapsed={false} onToggleCollapsed={() => {}} />
    </MemoryRouter>,
  );
  return screen.getAllByRole('link').map((link) => link.textContent?.trim() ?? '');
}

const EMPLOYEE = DEFAULT_ROLE_PERMISSIONS.EMPLOYEE;
const OFFICE_BOY = DEFAULT_ROLE_PERMISSIONS.LUNCH_OPERATOR;
const HR_ADMIN = DEFAULT_ROLE_PERMISSIONS.HR_ADMIN;

describe('what an employee is shown', () => {
  it('shows the screens that are theirs', () => {
    const links = sidebarFor(EMPLOYEE);

    for (const label of [
      'Dashboard',
      'Attendance',
      'My leave',
      'Leave requests',
      'My corrections',
      'Timesheets',
      'Lunch',
      'My cases',
      'Loans',
      'Medical',
      'Payslips',
      'Holidays',
      'Organisation',
    ]) {
      expect(links).toContain(label);
    }
  });

  it('shows none of the screens that are somebody else’s job', () => {
    const links = sidebarFor(EMPLOYEE);

    for (const label of [
      'People',
      'Payroll',
      'Case queue',
      'Lunch collection',
      'Correction centre',
      'Leave types',
      'Devices',
      'Device punches',
      'Employee Master Report',
      'Team attendance',
      'Attendance reports',
    ]) {
      expect(links).not.toContain(label);
    }
  });

  it('never shows an employee the lunch desk, which is the office boy’s screen', () => {
    // The distinction the whole lunch module is built on: "Lunch" is your own
    // order, "Lunch collection" is a day's cash. An employee holds the first
    // grant and not the second.
    expect(EMPLOYEE).toContain(PERMISSIONS.LUNCH_ORDER_READ_OWN);
    expect(EMPLOYEE).not.toContain(PERMISSIONS.LUNCH_COLLECTION_READ);

    const links = sidebarFor(EMPLOYEE);
    expect(links).toContain('Lunch');
    expect(links).not.toContain('Lunch collection');
  });

  it('never shows an employee the case queue, which is the helpdesk’s', () => {
    expect(EMPLOYEE).toContain(PERMISSIONS.CASE_READ_OWN);
    expect(EMPLOYEE).not.toContain(PERMISSIONS.CASE_READ_DEPARTMENT);
    expect(EMPLOYEE).not.toContain(PERMISSIONS.CASE_READ_ALL);

    const links = sidebarFor(EMPLOYEE);
    expect(links).toContain('My cases');
    expect(links).not.toContain('Case queue');
  });

  it('calls the employee’s own list "My cases", not "Cases"', () => {
    const links = sidebarFor(EMPLOYEE);

    expect(links).toContain('My cases');
    // The bare label read as the helpdesk itself, which is the queue next door.
    expect(links).not.toContain('Cases');
  });

  it('is a short list - the point of the exercise', () => {
    /*
     * Twenty before, with the employee's own attendance below Approvals and
     * their own leave below Device punches. What remains is what an employee
     * genuinely holds a grant for - Settings among it, because every member of
     * staff holds company.read and the screen behind it is the company's own
     * profile, read-only.
     */
    expect(sidebarFor(EMPLOYEE).length).toBeLessThanOrEqual(17);
  });
});

describe('the order an employee reads it in', () => {
  const orderOf = (links: string[], labels: string[]) => labels.map((l) => links.indexOf(l));

  it('puts the dashboard first and the most-used screens directly under it', () => {
    const links = sidebarFor(EMPLOYEE);

    const sequence = orderOf(links, [
      'Dashboard',
      'Attendance',
      'My leave',
      'Leave requests',
      'My corrections',
      'Timesheets',
    ]);

    expect(sequence).not.toContain(-1);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  });

  it('puts lunch at the head of the services, above loans and medical', () => {
    const links = sidebarFor(EMPLOYEE);

    const sequence = orderOf(links, ['Lunch', 'My cases', 'Loans', 'Medical']);

    expect(sequence).not.toContain(-1);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  });

  it('puts every personal screen above the company reference screens', () => {
    const links = sidebarFor(EMPLOYEE);

    for (const mine of ['Attendance', 'My leave', 'Lunch', 'My cases', 'Payslips']) {
      expect(links.indexOf(mine)).toBeLessThan(links.indexOf('Holidays'));
      expect(links.indexOf(mine)).toBeLessThan(links.indexOf('Organisation'));
    }
  });

  it('groups them under headings an employee would recognise', () => {
    permissions = new Set(EMPLOYEE);
    render(
      <MemoryRouter>
        <SidebarNav collapsed={false} onToggleCollapsed={() => {}} />
      </MemoryRouter>,
    );

    for (const heading of ['My work', 'My services', 'Documents', 'Company']) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    // Sections whose every item is hidden are not rendered as bare headings.
    expect(screen.queryByText('Management')).not.toBeInTheDocument();
  });
});

describe('the office boy', () => {
  it('gets the lunch desk and his own lunch, and nothing of HR', () => {
    const links = sidebarFor(OFFICE_BOY);

    expect(links).toContain('Lunch');
    expect(links).toContain('Lunch collection');

    for (const label of ['People', 'Payroll', 'Payslips', 'Medical', 'Loans', 'Settings']) {
      expect(links).not.toContain(label);
    }
  });
});

describe('an administrator', () => {
  it('still reaches the management screens', () => {
    const links = sidebarFor(HR_ADMIN);

    for (const label of ['People', 'Settings', 'Leave types', 'Correction centre']) {
      expect(links).toContain(label);
    }
  });

  it('has their own personal screens too, above the ones that are their job', () => {
    const links = sidebarFor(HR_ADMIN);

    expect(links.indexOf('Attendance')).toBeLessThan(links.indexOf('People'));
  });
});

describe('the registry itself', () => {
  it('has no duplicate destinations - one row per screen', () => {
    const paths = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.to));
    expect(new Set(paths).size).toBe(paths.length);
  });

  /*
   * Exactly three rows were re-gated, and they are listed here so each is a
   * decision on the record rather than a drift nobody can date later. All three
   * were previously gated on a grant EVERY member of staff holds, which meant
   * the gate could not distinguish an administrator from anybody else - so the
   * row was shown to all eighty people for a screen only a handful could use.
   *
   * None of this changes an entitlement. The endpoints behind these screens are
   * untouched, the URLs still work for whoever the SERVER lets in, and a reader
   * who loses a row loses a signpost rather than a right.
   */
  const REGATED: ReadonlyArray<[string, string]> = [
    // The correction form inside has always required attendance.manage.
    ['/attendance/corrections', PERMISSIONS.ATTENDANCE_MANAGE],
    // Screens about a GROUP of colleagues. An employee's own data scope showed
    // them a team of one - themselves - which is the attendance page they have.
    ['/attendance/team', PERMISSIONS.EMPLOYEE_READ],
    ['/attendance/reports', PERMISSIONS.EMPLOYEE_READ],
  ];

  it('re-gates exactly the three rows every employee could see but not use', () => {
    const byPath = new Map(NAV_SECTIONS.flatMap((s) => s.items).map((i) => [i.to, i.permission]));

    for (const [path, permission] of REGATED) {
      expect(byPath.get(path), path).toBe(permission);
      // The point of each change: an employee no longer sees it...
      expect(EMPLOYEE).not.toContain(permission);
      // ...and the people whose job it is still do.
      expect(HR_ADMIN).toContain(permission);
    }
  });

  it('leaves every other entry on the grant it already carried', () => {
    const byPath = new Map(
      NAV_SECTIONS.flatMap((s) => s.items).map((i) => [i.to, i.permission]),
    );

    // Spot-checked against the pre-reshuffle registry: a regrouping must not
    // quietly become a re-permissioning.
    expect(byPath.get('/attendance')).toBe(PERMISSIONS.ATTENDANCE_READ);
    expect(byPath.get('/attendance/my-corrections')).toBe(PERMISSIONS.ATTENDANCE_READ);
    expect(byPath.get('/approvals')).toBe(PERMISSIONS.APPROVAL_READ);
    expect(byPath.get('/shifts')).toBe(PERMISSIONS.SHIFT_READ);
    expect(byPath.get('/leave/me')).toBe(PERMISSIONS.LEAVE_READ);
    expect(byPath.get('/timesheets')).toBe(PERMISSIONS.TIMESHEET_READ);
    expect(byPath.get('/lunch')).toBe(PERMISSIONS.LUNCH_ORDER_READ_OWN);
    expect(byPath.get('/lunch-collection')).toBe(PERMISSIONS.LUNCH_COLLECTION_READ);
    expect(byPath.get('/cases')).toBe(PERMISSIONS.CASE_READ_OWN);
    expect(byPath.get('/payslips')).toBe(PERMISSIONS.PAYSLIP_READ);
    expect(byPath.get('/holidays')).toBe(PERMISSIONS.HOLIDAY_READ);
  });
});
