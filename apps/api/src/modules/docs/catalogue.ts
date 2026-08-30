import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Which documents exist, where they live, and who may read them.
 *
 * This map is also the whole of the path-traversal defence. A request names a
 * **slug**, and a slug is a key into this object - it is never joined onto a
 * path, never resolved, never interpolated. `../../.env` is not a slug, so it
 * does not resolve to anything; it is a 404 before any filesystem call happens.
 * The reader additionally refuses a resolved path outside `docs/`, but that is
 * a second lock on a door that has no handle.
 *
 * Adding a document means adding one entry here and dropping the file in
 * `docs/`. Nothing is generated, bundled or copied - the file on disk stays the
 * single source of truth, and editing it changes what the application serves.
 */

export interface DocEntry {
  slug: string;
  /** File name within `docs/`. Never taken from a request. */
  file: string;
  title: string;
  /** One line for the card on the documentation home. */
  summary: string;
  category: DocCategoryKey;
  /**
   * Required to read it. Omitted means any authenticated user.
   *
   * Gated documents are the ones whose own text carries operational or security
   * detail: how suspension works, what the push token protects, where the
   * limitations are. An employee gains nothing from them and the documentation
   * itself marks them as administrative.
   */
  permission?: Permission;
  /** Ordering within its category. */
  order: number;
}

export const DOC_CATEGORIES = [
  {
    key: 'getting-started',
    title: 'Getting started',
    description: 'What the system does, and what to configure first.',
  },
  {
    key: 'workforce',
    title: 'Workforce',
    description: 'Day-to-day guides for staff and the people who manage them.',
  },
  {
    key: 'time',
    title: 'Time and attendance',
    description: 'Shifts, attendance, timesheets and the terminals that feed them.',
  },
  {
    key: 'payroll',
    title: 'Payroll',
    description: 'Salaries, runs, payslips and every calculation rule.',
  },
  {
    key: 'administration',
    title: 'Administration',
    description: 'Company setup, users, roles, security and the audit trail.',
  },
  {
    key: 'support',
    title: 'Support and reference',
    description: 'What to do when something is wrong, and what is actually built.',
  },
  {
    key: 'technical',
    title: 'Technical reference',
    description: 'Implementation notes written for developers rather than operators.',
  },
] as const;

export type DocCategoryKey = (typeof DOC_CATEGORIES)[number]['key'];

export const DOC_ENTRIES: readonly DocEntry[] = [
  // --- getting started -------------------------------------------------------
  {
    slug: 'overview',
    file: 'HRMS-DOCUMENTATION-INDEX.md',
    title: 'Documentation index',
    summary: 'Where everything is, and the three things to know before reading anything else.',
    category: 'getting-started',
    order: 1,
  },
  {
    slug: 'user-manual',
    file: 'HRMS-USER-MANUAL.md',
    title: 'HRMS overview',
    summary: 'What the system does, how the modules connect, and who can do what.',
    category: 'getting-started',
    order: 2,
  },
  {
    slug: 'quick-start',
    file: 'HRMS-QUICK-START.md',
    title: 'Quick start',
    summary: 'What must be configured before the first employee can use the system.',
    category: 'getting-started',
    permission: PERMISSIONS.COMPANY_MANAGE,
    order: 3,
  },

  // --- workforce -------------------------------------------------------------
  {
    slug: 'employee-guide',
    file: 'HRMS-EMPLOYEE-GUIDE.md',
    title: 'Employee guide',
    summary: 'Everything you can do yourself: attendance, leave, timesheets and payslips.',
    category: 'workforce',
    order: 1,
  },
  {
    slug: 'manager-guide',
    file: 'HRMS-MANAGER-GUIDE.md',
    title: 'Manager guide',
    summary: 'The daily workflow for managers, and what approving actually does.',
    category: 'workforce',
    permission: PERMISSIONS.APPROVAL_ACT,
    order: 2,
  },

  // --- time ------------------------------------------------------------------
  {
    slug: 'attendance',
    file: 'HRMS-ATTENDANCE-GUIDE.md',
    title: 'Attendance guide',
    summary: 'The full lifecycle and every calculation rule, exactly as implemented.',
    category: 'time',
    order: 1,
  },
  {
    slug: 'devices',
    file: 'HRMS-DEVICE-GUIDE.md',
    title: 'Device guide (ZKTeco, ADMS)',
    summary: 'Registering terminals, pull and push synchronisation, and raw punches.',
    category: 'time',
    permission: PERMISSIONS.DEVICE_READ,
    order: 2,
  },

  // --- payroll ---------------------------------------------------------------
  {
    slug: 'payroll',
    file: 'HRMS-PAYROLL-GUIDE.md',
    title: 'Payroll guide',
    summary: 'Salaries, the run workflow, every calculation rule, payslips and reports.',
    category: 'payroll',
    permission: PERMISSIONS.PAYROLL_READ,
    order: 1,
  },

  // --- administration --------------------------------------------------------
  {
    slug: 'admin-manual',
    file: 'HRMS-ADMIN-MANUAL.md',
    title: 'Administrator manual',
    summary: 'Employees, settings, users, approvals, security, audit and known limitations.',
    category: 'administration',
    permission: PERMISSIONS.COMPANY_MANAGE,
    order: 1,
  },

  // --- support ---------------------------------------------------------------
  {
    slug: 'troubleshooting',
    file: 'HRMS-TROUBLESHOOTING.md',
    title: 'Troubleshooting',
    summary: 'Symptoms, causes and what to actually do, across every module.',
    category: 'support',
    order: 1,
  },
  {
    slug: 'feature-matrix',
    file: 'HRMS-FEATURE-MATRIX.md',
    title: 'Feature status',
    summary: 'What is implemented, partially implemented, pending, and not built at all.',
    category: 'support',
    order: 2,
  },

  // --- technical -------------------------------------------------------------
  // Written for developers. Gated on settings.manage, which only Super Admin
  // holds by default: they describe internals rather than how to operate the
  // system, and an operator reading them would be misled about what matters.
  {
    slug: 'architecture',
    file: 'architecture.md',
    title: 'Architecture',
    summary: 'How the codebase is laid out.',
    category: 'technical',
    permission: PERMISSIONS.SETTINGS_MANAGE,
    order: 1,
  },
  {
    slug: 'attendance-devices-technical',
    file: 'attendance-devices.md',
    title: 'Attendance devices (implementation)',
    summary: 'The device protocols in implementation terms.',
    category: 'technical',
    permission: PERMISSIONS.SETTINGS_MANAGE,
    order: 2,
  },
  {
    slug: 'payroll-technical',
    file: 'payroll.md',
    title: 'Payroll engine (implementation)',
    summary: 'The payroll engine in implementation terms.',
    category: 'technical',
    permission: PERMISSIONS.SETTINGS_MANAGE,
    order: 3,
  },
  {
    slug: 'roadmap',
    file: 'roadmap.md',
    title: 'Roadmap',
    summary: 'What was built in each phase, and what was deliberately not.',
    category: 'technical',
    permission: PERMISSIONS.SETTINGS_MANAGE,
    order: 4,
  },
  {
    slug: 'feature-map',
    file: 'feature-map.md',
    title: 'Feature map',
    summary: 'The original scoping decisions.',
    category: 'technical',
    permission: PERMISSIONS.SETTINGS_MANAGE,
    order: 5,
  },
];

/** Slug lookup. A request can only ever name a key of this map. */
export const DOC_BY_SLUG: ReadonlyMap<string, DocEntry> = new Map(
  DOC_ENTRIES.map((entry) => [entry.slug, entry]),
);

/** Reverse lookup, so a link between documents can be rewritten to a route. */
export const DOC_BY_FILE: ReadonlyMap<string, DocEntry> = new Map(
  DOC_ENTRIES.map((entry) => [entry.file.toLowerCase(), entry]),
);

/**
 * Contextual help: which document a module's Help link opens.
 *
 * Kept here rather than in each screen so the mapping is visible in one place
 * and cannot drift as documents are renamed.
 */
export const MODULE_HELP: Readonly<Record<string, string>> = {
  payroll: 'payroll',
  payslips: 'payroll',
  attendance: 'attendance',
  timesheets: 'attendance',
  shifts: 'attendance',
  devices: 'devices',
  punches: 'devices',
  leave: 'employee-guide',
  holidays: 'employee-guide',
  people: 'admin-manual',
  settings: 'admin-manual',
  users: 'admin-manual',
  approvals: 'manager-guide',
};
