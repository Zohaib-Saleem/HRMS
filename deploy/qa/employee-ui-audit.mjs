/**
 * Employee-side UI audit. Read-only: signs in as the temporary QA account,
 * visits every route an employee can reach, records console errors, failed
 * requests and the final rendered state, and captures desktop + mobile
 * screenshots. Performs no writes.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = 'https://hrms.gamempires.com';
const EMAIL = process.env.QA_EMAIL;
const PASSWORD = process.env.QA_PASSWORD;

const ROUTES = [
  ['/',                 'Dashboard'],
  ['/profile',          'My profile'],
  ['/attendance',       'Attendance'],
  ['/attendance/team',  'Team attendance'],
  ['/leave/me',         'My leave'],
  ['/leave/requests',   'Leave requests'],
  ['/holidays',         'Holidays'],
  ['/shifts',           'Shifts'],
  ['/timesheets',       'Timesheets'],
  ['/payslips',         'Payslips'],
  ['/approvals',        'Approvals'],
  ['/help',             'Help'],
  // Should render the "no access" card, not a crash:
  ['/people',           'People (admin-only)'],
  ['/settings/users',   'Users (admin-only)'],
  ['/payroll',          'Payroll (admin-only)'],
  ['/settings/roles',   'Roles (admin-only)'],
  ['/nonexistent-page', '404 route'],
];

const results = [];

for (const [device, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile',  { width: 390,  height: 844 }],
]) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) {
      failedRequests.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
    }
  });

  // --- sign in ---
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `/out/${device}-00-login.png`, fullPage: true });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState('networkidle');

  let i = 1;
  for (const [route, label] of ROUTES) {
    const before = consoleErrors.length, beforeReq = failedRequests.length;
    await page.goto(BASE + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    const heading = await page.locator('h1, h2').first().innerText().catch(() => '(none)');
    const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
    const noAccess = /do not have access/i.test(bodyText);
    const notFound = /Page not found/i.test(bodyText);
    const spinner = await page.locator('[role="status"], .animate-spin').count();

    const file = `/out/${device}-${String(i).padStart(2, '0')}-${route.replace(/\W+/g, '_') || 'root'}.png`;
    await page.screenshot({ path: file, fullPage: true });

    results.push({
      device, route, label,
      heading: heading.replace(/\s+/g, ' ').slice(0, 80),
      noAccess, notFound, spinnersLeft: spinner,
      newConsoleErrors: consoleErrors.slice(before),
      newFailedRequests: failedRequests.slice(beforeReq),
      textSample: bodyText.replace(/\s+/g, ' ').slice(0, 700),
      screenshot: file,
    });
    i += 1;
  }

  // logout check on desktop only
  if (device === 'desktop') {
    const navText = await page.locator('nav, aside').first().innerText().catch(() => '');
    results.push({ device, route: 'NAVIGATION', label: 'sidebar items', textSample: navText.replace(/\s+/g, ' ') });
  }

  await browser.close();
}

writeFileSync('/out/results.json', JSON.stringify(results, null, 2));
console.log('routes audited:', results.length);
