import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';
import { TABS, visibleTabs, type SettingsTab } from './settings-layout';
import { capabilityFrom, isMissingEndpoint, isUnreachable } from '@/lib/capability';
import { ApiError, NetworkError } from '@/lib/api';

/**
 * Which Settings tabs a given user sees, and when.
 *
 * The web app and the API deploy separately, so Attendance rules can ship
 * before the endpoint it reads. These assert the two gates that decide whether
 * it appears: the permission the user holds, and whether the endpoint actually
 * answers. Both are needed; neither alone is enough.
 */

const label = (tabs: readonly SettingsTab[]) => tabs.map((t) => t.label);

/** A caller holding exactly these permissions. */
const holding =
  (...permissions: Permission[]) =>
  (permission: Permission) =>
    permissions.includes(permission);

const SUPER_ADMIN = holding(
  PERMISSIONS.COMPANY_READ,
  PERMISSIONS.COMPANY_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.USER_READ,
  PERMISSIONS.ROLE_READ,
  PERMISSIONS.AUDIT_READ,
);
const HR_ADMIN = holding(
  PERMISSIONS.COMPANY_READ,
  PERMISSIONS.COMPANY_MANAGE,
  PERMISSIONS.USER_READ,
  PERMISSIONS.AUDIT_READ,
);
const MANAGER = holding(PERMISSIONS.EMPLOYEE_READ);
const EMPLOYEE = holding(PERMISSIONS.LEAVE_READ);

const show = (has: (p: Permission) => boolean, attendanceRules: 'checking' | 'available' | 'unavailable') =>
  visibleTabs(TABS, { has, capabilities: { attendanceRules } });

describe('Attendance rules follows the endpoint, not a flag', () => {
  it('is hidden while the endpoint is missing', () => {
    // Today's production: the API predates the endpoint and answers 404.
    expect(label(show(SUPER_ADMIN, 'unavailable'))).not.toContain('Attendance rules');
  });

  it('appears once the endpoint answers, with no frontend change', () => {
    expect(label(show(SUPER_ADMIN, 'available'))).toContain('Attendance rules');
  });

  it('stays hidden while the answer is still unknown', () => {
    // Showing it and then removing it a moment later reads as a glitch.
    expect(label(show(SUPER_ADMIN, 'checking'))).not.toContain('Attendance rules');
  });
});

describe('every other Settings tab is unaffected', () => {
  const others = ['Company', 'Attendance policy', 'Policy overrides', 'Users', 'Roles and permissions', 'Audit log'];

  it('shows the rest to a Super Admin whatever the endpoint says', () => {
    for (const state of ['checking', 'available', 'unavailable'] as const) {
      expect(label(show(SUPER_ADMIN, state))).toEqual(expect.arrayContaining(others));
    }
  });

  it('does not change how many other tabs are shown', () => {
    const withRules = label(show(SUPER_ADMIN, 'available'));
    const without = label(show(SUPER_ADMIN, 'unavailable'));
    expect(withRules.length - without.length).toBe(1);
    expect(without).toEqual(withRules.filter((l) => l !== 'Attendance rules'));
  });
});

describe('permission still gates the tab, availability does not widen it', () => {
  it('shows it to HR Admin, who may read the rules but not change them', () => {
    // Read access is company.read; the endpoint itself refuses their writes.
    expect(label(show(HR_ADMIN, 'available'))).toContain('Attendance rules');
  });

  it('never shows it to a manager, even when the endpoint is up', () => {
    expect(label(show(MANAGER, 'available'))).not.toContain('Attendance rules');
  });

  it('never shows it to an employee, even when the endpoint is up', () => {
    expect(label(show(EMPLOYEE, 'available'))).not.toContain('Attendance rules');
  });

  it('shows a manager and an employee no Settings tabs at all', () => {
    expect(label(show(MANAGER, 'available'))).toEqual([]);
    expect(label(show(EMPLOYEE, 'available'))).toEqual([]);
  });

  it('shows HR Admin only what it holds the permission for', () => {
    expect(label(show(HR_ADMIN, 'available'))).not.toContain('Roles and permissions');
  });
});

describe('what counts as unavailable', () => {
  it('is checking while the probe is in flight', () => {
    expect(capabilityFrom({ isPending: true, isError: false })).toBe('checking');
  });

  it('is available only on a successful answer', () => {
    expect(capabilityFrom({ isPending: false, isError: false })).toBe('available');
  });

  it('is unavailable on any failure at all', () => {
    // 404 not deployed, 401/403 not permitted, 5xx or a dropped connection.
    // None of them is worth an error card on a screen nobody asked for.
    expect(capabilityFrom({ isPending: false, isError: true })).toBe('unavailable');
  });

  it('tells a missing endpoint apart from a refusal', () => {
    const notDeployed = new ApiError(404, { code: 'NOT_FOUND', message: 'x' });
    const refused = new ApiError(403, { code: 'FORBIDDEN', message: 'x' });

    expect(isMissingEndpoint(notDeployed)).toBe(true);
    expect(isMissingEndpoint(refused)).toBe(false);
    expect(isUnreachable(new NetworkError())).toBe(true);
    expect(isUnreachable(notDeployed)).toBe(false);
  });
});
