/**
 * Compensation tab, checked on the live site. Read-only: signs in, navigates,
 * looks, and performs no writes.
 *
 * Two roles, two different correct answers:
 *   - an admin holding payroll.read must SEE the Compensation tab on a profile
 *   - an employee holding neither payroll.read nor employee.read must NOT reach
 *     a profile at all, so the tab is unreachable for them
 *
 * Credentials come from the environment and are never printed.
 *   QA_EMAIL / QA_PASSWORD        the employee-role account (negative case)
 *   ADMIN_EMAIL / ADMIN_PASSWORD  an account holding payroll.read (positive case)
 * Either pair may be omitted; the corresponding case is then reported as skipped.
 */
import { chromium } from 'playwright';

const BASE = process.env.HRMS_BASE ?? 'https://hrms.gamempires.com';
const results = [];
const note = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function signIn(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 25_000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState('networkidle');
}

async function withBrowser(viewport, fn) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  try {
    await fn(page, consoleErrors);
  } finally {
    await browser.close();
  }
}

// --------------------------------------------------------- negative: employee
async function employeeCase(viewport, label) {
  const email = process.env.QA_EMAIL;
  const password = process.env.QA_PASSWORD;
  if (!email || !password) {
    console.log(`  SKIP  employee case (${label}) — QA_EMAIL/QA_PASSWORD not set`);
    return;
  }
  await withBrowser(viewport, async (page, errors) => {
    await signIn(page, email, password);
    note(`employee signs in (${label})`, !page.url().includes('/login'));

    await page.goto(`${BASE}/people`, { waitUntil: 'networkidle' });
    const body = await page.textContent('body');
    const blocked = /no access|permission|not allowed/i.test(body ?? '');
    note(`employee cannot open People (${label})`, blocked, blocked ? 'access card shown' : 'people list rendered');

    const compTab = await page.locator('button:has-text("Compensation"), a:has-text("Compensation")').count();
    note(`employee sees no Compensation entry (${label})`, compTab === 0, `${compTab} found`);

    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
    const rulesTab = await page.locator('a[href="/settings/attendance-rules"]').count();
    note(`employee sees no Attendance rules tab (${label})`, rulesTab === 0);

    note(`no page errors as employee (${label})`, errors.length === 0, errors.slice(0, 2).join(' | '));
  });
}

// ------------------------------------------------------------ positive: admin
async function adminCase(viewport, label) {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log(`  SKIP  admin case (${label}) — ADMIN_EMAIL/ADMIN_PASSWORD not set`);
    return;
  }
  await withBrowser(viewport, async (page, errors) => {
    await signIn(page, email, password);
    note(`admin signs in (${label})`, !page.url().includes('/login'));

    // First real employee row, opened read-only.
    await page.goto(`${BASE}/people`, { waitUntil: 'networkidle' });
    const first = page.locator('a[href^="/people/"]').first();
    note(`admin sees the people list (${label})`, (await first.count()) > 0);
    await first.click();
    await page.waitForLoadState('networkidle');

    const tab = page.locator('button:has-text("Compensation")').first();
    note(`Compensation tab is present on the profile (${label})`, (await tab.count()) > 0);

    await tab.click();
    await page.waitForLoadState('networkidle');
    const body = await page.textContent('body');
    const rendered =
      /Salary history/i.test(body ?? '') &&
      /Allowances/i.test(body ?? '') &&
      /Deductions/i.test(body ?? '');
    note(`Compensation panel renders its sections (${label})`, rendered);

    const empty = /No salary on record/i.test(body ?? '');
    note(`empty state shown when no salary exists (${label})`, empty, empty ? 'as expected: production holds 0 salaries' : 'a salary is recorded');

    // The guard: Attendance rules must be hidden while the API answers 404.
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const rulesTab = await page.locator('a[href="/settings/attendance-rules"]').count();
    const otherTabs = await page.locator('nav[aria-label="Settings sections"] a').count();
    note(`Attendance rules tab hidden while endpoint is 404 (${label})`, rulesTab === 0);
    note(`other Settings tabs still present (${label})`, otherTabs >= 3, `${otherTabs} tabs`);

    note(`no page errors as admin (${label})`, errors.length === 0, errors.slice(0, 2).join(' | '));
  });
}

console.log(`\nCompensation check against ${BASE}\n`);
for (const [label, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  await employeeCase(viewport, label);
  await adminCase(viewport, label);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} FAILED` : ''}\n`);
process.exit(failed.length ? 1 : 0);
