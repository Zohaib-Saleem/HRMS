/**
 * Post-fix UI regression. Read-only: signs in, visits every route both roles
 * can reach, and records console errors, failed requests, horizontal overflow
 * and the rendered state at two viewports.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = 'https://hrms.gamempires.com';

const ACCOUNTS = [
  { role: 'employee', email: process.env.QA_EMAIL, password: process.env.QA_PASSWORD, routes: [
    ['/', 'Dashboard'], ['/profile', 'Profile'], ['/attendance', 'Attendance'],
    ['/attendance/team', 'Team attendance'], ['/leave/me', 'My leave'],
    ['/leave/requests', 'Leave requests'], ['/holidays', 'Holidays'],
    ['/shifts', 'Shifts'], ['/timesheets', 'Timesheets'], ['/payslips', 'Payslips'],
    ['/approvals', 'Approvals'], ['/help', 'Help'],
    ['/people', 'People (denied)'], ['/settings/users', 'Users (denied)'],
    ['/payroll', 'Payroll (denied)'], ['/nope', '404'],
  ]},
  { role: 'admin', email: 'admin@hrms.local', password: process.env.ADMIN_PASSWORD, routes: [
    ['/', 'Dashboard'], ['/people', 'People'], ['/settings/company', 'Company settings'],
    ['/payroll', 'Payroll'], ['/settings/users', 'Users'], ['/attendance', 'Attendance'],
  ]},
];

const results = [];

for (const account of ACCOUNTS) {
  for (const [device, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await ctx.newPage();

    const consoleErrors = [], failed = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
    page.on('requestfailed', (r) => failed.push(`FAILED ${r.method()} ${r.url()}`));
    page.on('response', (r) => {
      if (r.status() >= 400 && r.url().includes('/api/')) {
        failed.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
      }
    });

    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', account.email);
    await page.fill('input[type="password"]', account.password);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 25000 }),
      page.click('button[type="submit"]'),
    ]);
    await page.waitForLoadState('networkidle');

    let i = 1;
    for (const [route, label] of account.routes) {
      const cBefore = consoleErrors.length, fBefore = failed.length;
      await page.goto(BASE + route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1400);

      const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      const spinners = await page.locator('.animate-spin').count();
      const file = `/out/fix-${account.role}-${device}-${String(i).padStart(2, '0')}-${route.replace(/\W+/g, '_') || 'root'}.png`;
      await page.screenshot({ path: file, fullPage: true });

      results.push({
        role: account.role, device, route, label,
        horizontalOverflow: overflow,
        spinnersLeft: spinners,
        noAccessCard: /do not have access/i.test(body),
        notFoundCard: /Page not found/i.test(body),
        consoleErrors: consoleErrors.slice(cBefore),
        failedRequests: failed.slice(fBefore),
        text: body.slice(0, 900),
        screenshot: file,
      });
      i += 1;
    }
    await browser.close();
  }
}

writeFileSync('/out/fix-results.json', JSON.stringify(results, null, 2));
console.log('route visits:', results.length);
