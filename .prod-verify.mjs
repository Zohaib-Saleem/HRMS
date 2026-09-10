/**
 * Post-deploy check of the real production UI. READ-ONLY: signs in, looks,
 * measures, screenshots. It writes nothing and calls no mutating endpoint.
 * The password comes from the environment so it need never be written down.
 *
 *   ADMIN_PASSWORD='...' node /opt/hrms/.prod-verify.mjs
 *
 * Optional: EMPLOYEE='Abdul Rehman'   ADMIN_EMAIL='...'   OUT=/some/dir
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'https://hrms.gamempires.com';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@hrms.local';
const PASSWORD = process.env.ADMIN_PASSWORD;
const EMPLOYEE = process.env.EMPLOYEE ?? '';
const OUT = process.env.OUT ?? '/tmp/hrms-prod-check';

if (!PASSWORD) {
  console.error('Set ADMIN_PASSWORD. Nothing was done.');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });

// Sign in ONCE and reuse the session: a login per viewport trips the rate
// limiter, which then looks like a page failure.
const authCtx = await browser.newContext();
const authPage = await authCtx.newPage();
await authPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await authPage.fill('input[type="email"]', EMAIL);
await authPage.fill('input[type="password"]', PASSWORD);
await authPage.click('button[type="submit"]');
try {
  // Not waitForURL: the SPA routes client-side and the 'load' it waits for
  // never fires, so it hangs even on a successful sign-in.
  await authPage.waitForSelector('nav[aria-label="Breadcrumb"]', { timeout: 30000 });
} catch {
  console.error('Sign-in did not complete - wrong credential? Nothing else was done.');
  await authPage.screenshot({ path: `${OUT}/login-failed.png` });
  await browser.close();
  process.exit(3);
}
await authPage.waitForTimeout(800);
const storageState = await authCtx.storageState();
await authCtx.close();

const report = [];

for (const [device, viewport] of [
  ['desktop-1440', { width: 1440, height: 900 }],
  ['tablet-834', { width: 834, height: 1112 }],
  ['mobile-390', { width: 390, height: 844 }],
]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, storageState });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text().slice(0, 160));
  });

  // Team Attendance listing: must carry NO switcher.
  await page.goto(`${BASE}/attendance/team`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const teamSwitcher = await page.getByRole('group', { name: /attendance view/i }).count();
  await page.screenshot({ path: `${OUT}/${device}-1-team-listing.png` });

  // Open an employee.
  const link = EMPLOYEE
    ? page.locator('table a[href^="/attendance/team/"]', { hasText: EMPLOYEE }).first()
    : page.locator('table a[href^="/attendance/team/"]').first();
  if ((await link.count()) === 0) {
    report.push({ device, ok: false, note: EMPLOYEE ? `No row for "${EMPLOYEE}"` : 'No employee rows' });
    await ctx.close();
    continue;
  }
  const employeeName = (await link.innerText()).split('\n')[0];
  await link.click();
  await page.waitForFunction(() => /\/attendance\/team\/.+/.test(location.pathname), null, { timeout: 20000 });
  await page.waitForTimeout(2500);

  const group = page.getByRole('group', { name: /attendance view/i });
  const switcherVisible = await group.isVisible().catch(() => false);
  const labels = switcherVisible ? await group.getByRole('button').allInnerTexts() : [];
  const calendarDefault = switcherVisible
    ? await group.getByRole('button', { name: /^Calendar$/ }).getAttribute('aria-pressed') : null;
  const calendarShown = await page.getByRole('grid', { name: /attendance calendar/i }).isVisible().catch(() => false);
  const breadcrumb = await page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]').innerText().catch(() => null);
  await page.screenshot({ path: `${OUT}/${device}-2-employee-calendar.png` });

  // Table.
  await group.getByRole('button', { name: /^Table$/ }).click();
  await page.waitForTimeout(1200);
  const headers = (await page.getByRole('columnheader').allInnerTexts()).slice(0, 11);
  await page.screenshot({ path: `${OUT}/${device}-3-table.png` });

  // Bars, plus the width and height measurements.
  await group.getByRole('button', { name: /^Bars$/ }).click();
  await page.waitForTimeout(1800);
  const list = page.getByRole('list', { name: /Worked hours per day/i });
  const items = list.getByRole('listitem');
  const n = await items.count();

  const geom = await page.evaluate(() => {
    const row = document.querySelector('[role="list"][aria-label*="Worked hours"]');
    const track = row.parentElement, scroller = track.parentElement;
    const t = track.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    return {
      scrollerWidth: +s.width.toFixed(1), trackWidth: +t.width.toFixed(1),
      scrollerClient: scroller.clientWidth, scrollerScrollWidth: scroller.scrollWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    };
  });

  const aria = await items.locator('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  const states = {
    present: aria.filter((l) => /Present/.test(l)).length,
    late: aria.filter((l) => /Late/.test(l)).length,
    overtime: aria.filter((l) => /minutes overtime/.test(l)).length,
    halfDay: aria.filter((l) => /Half day/.test(l)).length,
    absent: aria.filter((l) => /Absent/.test(l)).length,
    onLeave: aria.filter((l) => /On leave/.test(l)).length,
    holidayWeekendOff: aria.filter((l) => /Holiday|Weekend|Off day/.test(l)).length,
    upcoming: aria.filter((l) => /Upcoming/.test(l)).length,
    missingPunch: aria.filter((l) => /missing punch/.test(l)).length,
  };

  // Bar height against the API's own workedMinutes - the engine stays the
  // single source of truth, and the width change must not have moved it.
  const plot = await list.boundingBox();
  const api = await page.evaluate(async (href) => {
    const id = href.split('/').pop();
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const r = await fetch(`/api/v1/attendance/summary?from=${from}&to=${to}&employeeId=${id}`, { credentials: 'same-origin' });
    return (await r.json()).data.days;
  }, page.url());
  const byDate = new Map(api.map((d) => [d.date, d]));
  const axisTopMin = Math.max(1, ...api.map((d) => d.workedMinutes ?? 0)) / 60;
  const step = [1, 2, 4, 8, 12, 24].find((s) => s >= axisTopMin / 4) ?? 24;
  const top = Math.max(step, Math.ceil(axisTopMin / step) * step) * 60;
  let worst = 0, measured = 0;
  for (let i = 0; i < n; i++) {
    const it = items.nth(i);
    const l = await it.getByRole('button').getAttribute('aria-label');
    const m = l.match(/, (\w+ \d+, \d+),/);
    if (!m) continue;
    const iso = new Date(m[1] + ' UTC').toISOString().slice(0, 10);
    const worked = byDate.get(iso)?.workedMinutes ?? 0;
    if (worked <= 0) continue;
    const segs = it.locator('> div:not([class*="absolute"])');
    let painted = 0;
    for (let s = 0; s < await segs.count(); s++) {
      const b = await segs.nth(s).boundingBox();
      if (b) painted += b.height;
    }
    worst = Math.max(worst, Math.abs(painted - (worked / top) * plot.height));
    measured++;
  }

  await items.first().locator('button').click();
  await page.waitForTimeout(500);
  const detail = await page.getByRole('status').innerText().catch(() => null);
  await list.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${device}-4-bars.png` });

  // Month navigation across the views.
  await page.getByRole('button', { name: 'Previous month' }).click();
  await page.waitForTimeout(2000);
  const barsPrev = await items.count().catch(() => 0);
  await group.getByRole('button', { name: /^Calendar$/ }).click();
  await page.waitForTimeout(1200);
  const calBack = await page.getByRole('grid', { name: /attendance calendar/i }).isVisible().catch(() => false);
  await page.screenshot({ path: `${OUT}/${device}-5-calendar-prev-month.png` });

  report.push({
    device, employeeName, breadcrumbLeaf: breadcrumb,
    teamListingSwitcherCount: teamSwitcher,
    switcherVisible, labels, calendarDefaultPressed: calendarDefault, calendarShown,
    tableHeaders: headers,
    bars: n, states,
    chartFillsCard: Math.abs(geom.trackWidth - geom.scrollerWidth) < 1.5,
    chartScrollsInsideItself: geom.scrollerScrollWidth > geom.scrollerClient + 1,
    pageScrollsSideways: geom.docScrollWidth > geom.docClientWidth + 1,
    ...geom,
    plotHeight: +plot.height.toFixed(1), barsMeasured: measured, worstHeightErrorPx: +worst.toFixed(2),
    detail,
    barsPreviousMonth: barsPrev, calendarReturned: calBack,
    errors,
  });
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
console.log(`\nScreenshots: ${OUT}`);
