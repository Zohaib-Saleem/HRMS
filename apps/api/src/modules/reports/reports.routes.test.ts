import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Who may open the Employee Master Report - on screen, as a CSV and as a
 * workbook.
 *
 * The report puts every module's figure for every employee on one sheet, and
 * it used to ride on `employee.read` alone, which every manager and team
 * manager holds for their own reporting line. It now needs its own grant AS
 * WELL, and the gate sits on the module so the three routes cannot drift:
 * a role that is refused the screen is refused the export by the same line.
 *
 * The roles are read off the shipped defaults rather than typed in, so this
 * file fails if a default ever quietly widens.
 */

const service = vi.hoisted(() => ({
  buildEmployeeMasterReport: vi.fn(),
  buildEmployeeMasterExport: vi.fn(),
  allowedColumns: vi.fn(() => ['fullName']),
}));

vi.mock('./employee-master.service.js', () => service);
vi.mock('../../core/db.js', () => ({ prisma: { auditLog: { create: vi.fn() } } }));

const { reportRoutes, REPORT_PERMISSIONS } = await import('./reports.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const REPORT = {
  from: '2026-09-01',
  to: '2026-09-30',
  rows: [],
  totals: { employees: 0, active: 0, currency: 'PKR' },
  meta: { page: 1, limit: 25, total: 0, totalPages: 0 },
  availableColumns: ['fullName'],
};

async function appAs(permissions: readonly Permission[]): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      email: 'someone@example.com',
      permissions: new Set(permissions),
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await app.register(reportRoutes, { prefix: '/reports' });
  await app.ready();
  return app;
}

const ROUTES = [
  '/reports/employee-master',
  '/reports/employee-master/export.csv',
  '/reports/employee-master/export.xlsx',
];

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  service.buildEmployeeMasterReport.mockResolvedValue(REPORT);
  service.buildEmployeeMasterExport.mockResolvedValue(REPORT);
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('the Employee Master Report is Super Admin and HR Admin only', () => {
  it('names both grants on its permission surface', () => {
    expect(REPORT_PERMISSIONS).toContain(PERMISSIONS.EMPLOYEE_READ);
    expect(REPORT_PERMISSIONS).toContain(PERMISSIONS.EMPLOYEE_MASTER_REPORT_READ);
  });

  it('ships the grant to Super Admin and HR Admin, and to nobody else', () => {
    const holders = Object.entries(DEFAULT_ROLE_PERMISSIONS)
      .filter(([, grants]) => grants.includes(PERMISSIONS.EMPLOYEE_MASTER_REPORT_READ))
      .map(([role]) => role)
      .sort();
    expect(holders).toEqual(['HR_ADMIN', 'SUPER_ADMIN']);
  });

  for (const url of ROUTES) {
    it(`lets Super Admin open ${url}`, async () => {
      app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
    });

    it(`lets HR Admin open ${url}`, async () => {
      app = await appAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN);
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
    });

    for (const role of ['MANAGER', 'TEAM_MANAGER', 'EMPLOYEE', 'IT_ASSET_MANAGER'] as const) {
      it(`refuses ${role} at ${url} with 403`, async () => {
        app = await appAs(DEFAULT_ROLE_PERMISSIONS[role]);
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(403);
        expect(service.buildEmployeeMasterReport).not.toHaveBeenCalled();
        expect(service.buildEmployeeMasterExport).not.toHaveBeenCalled();
      });
    }
  }

  it('refuses the report grant on its own, without employee.read', async () => {
    // The grant says "the consolidated view"; employee.read says "employees at
    // all". Somebody handed the first without the second gets nothing.
    app = await appAs([PERMISSIONS.EMPLOYEE_MASTER_REPORT_READ]);
    const res = await app.inject({ method: 'GET', url: '/reports/employee-master' });
    expect(res.statusCode).toBe(403);
  });

  it('refuses employee.read on its own, which is what every manager holds', async () => {
    app = await appAs([PERMISSIONS.EMPLOYEE_READ]);
    for (const url of ROUTES) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(403);
    }
  });
});
