/**
 * Help centre audit.
 *
 * Two halves. The first drives the parser directly, because a markdown parser
 * is worth testing against constructs rather than against a server. The second
 * drives the real API: who may read what, that a slug is a lookup key and not a
 * path, and that the documents on disk still parse into something with content
 * in it.
 *
 * Creates nothing and removes nothing - the documentation is read-only.
 *
 *   npx dotenv -e .env -- npx tsx scripts/audit-docs.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import {
  blocksToText,
  headingSlug,
  parseInline,
  parseMarkdown,
} from '../apps/api/src/modules/docs/markdown.ts';
import { DOC_ENTRIES } from '../apps/api/src/modules/docs/catalogue.ts';

const BASE = 'http://127.0.0.1:4000/api/v1';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label} (${JSON.stringify(actual)})`);
  } else {
    fail += 1;
    console.log(
      `  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`,
    );
  }
}

const truthy = (label, actual) => check(label, Boolean(actual), true);
const section = (title) => console.log(`\n################ ${title} ################`);

let ipCounter = 0;
async function login(email, password) {
  ipCounter += 1;
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${ipCounter}` },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) throw new Error(`login failed for ${email}: ${response.status}`);
  return (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

async function api(cookie, path) {
  const response = await fetch(`${BASE}${path}`, { headers: { cookie } });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body, text };
}

let adminCookie = null;
let managerCookie = null;
let employeeCookie = null;

try {
  section('PARSER: BLOCKS');

  {
    const blocks = parseMarkdown('# Title\n\nA paragraph.\n');
    check('a heading parses', blocks[0].type, 'heading');
    check('at the right level', blocks[0].level, 1);
    check('with an anchor', blocks[0].slug, 'title');
    check('a paragraph follows', blocks[1].type, 'paragraph');
  }

  {
    const blocks = parseMarkdown('- one\n- two\n- three\n');
    check('a bullet list parses', blocks[0].type, 'list');
    check('unordered', blocks[0].ordered, false);
    check('with every item', blocks[0].items.length, 3);
  }

  {
    const blocks = parseMarkdown('1. first\n2. second\n');
    check('a numbered list parses', blocks[0].ordered, true);
    check('with its start', blocks[0].start, 1);
  }

  {
    const blocks = parseMarkdown('- outer\n  - inner one\n  - inner two\n- second outer\n');
    check('a nested list keeps two outer items', blocks[0].items.length, 2);
    check('and nests the children', blocks[0].items[0].children.length, 2);
  }

  {
    const blocks = parseMarkdown('| A | B |\n|---|---:|\n| 1 | 2 |\n| 3 | 4 |\n');
    check('a table parses', blocks[0].type, 'table');
    check('with its header', blocks[0].head.length, 2);
    check('and its rows', blocks[0].rows.length, 2);
    check('honouring alignment', blocks[0].align[1], 'right');
  }

  {
    const blocks = parseMarkdown('```bash\nnpm run dev\n```\n');
    check('a fenced block parses', blocks[0].type, 'code');
    check('keeping its language', blocks[0].language, 'bash');
    check('and its body verbatim', blocks[0].value, 'npm run dev');
  }

  {
    const blocks = parseMarkdown('> A quote.\n> Still the quote.\n');
    check('a block quote parses', blocks[0].type, 'quote');
    check('with blocks inside it', blocks[0].blocks[0].type, 'paragraph');
  }

  {
    const blocks = parseMarkdown('one\n\n---\n\ntwo\n');
    check('a horizontal rule parses', blocks[1].type, 'rule');
  }

  section('PARSER: INLINE');

  {
    const nodes = parseInline('plain **bold** and `code` and *emphasis* and ~~gone~~');
    const kinds = nodes.map((n) => n.type);
    truthy('bold is recognised', kinds.includes('strong'));
    truthy('inline code is recognised', kinds.includes('code'));
    truthy('emphasis is recognised', kinds.includes('em'));
    truthy('strikethrough is recognised', kinds.includes('strike'));
  }

  {
    const nodes = parseInline('see [the guide](HRMS-PAYROLL-GUIDE.md#salary) for detail');
    const link = nodes.find((n) => n.type === 'link');
    truthy('a link is recognised', link !== undefined);
    check('with its text', link.value, 'the guide');
    check('and its target', link.href, 'HRMS-PAYROLL-GUIDE.md#salary');
    check('marked internal', link.external, false);
  }

  {
    const nodes = parseInline('visit [the site](https://example.com)');
    check('an external link is marked as such', nodes.find((n) => n.type === 'link').external, true);
  }

  {
    // A code span wins: the documentation quotes markdown constantly, and
    // interpreting the asterisks inside one would mangle it.
    const nodes = parseInline('use `**literal**` here');
    const code = nodes.find((n) => n.type === 'code');
    check('markdown inside a code span stays literal', code.value, '**literal**');
    check('and produces no bold node', nodes.some((n) => n.type === 'strong'), false);
  }

  {
    check('anchors match the documents own links', headingSlug('12. Known limitations'), '12-known-limitations');
    check('punctuation is dropped', headingSlug('Roles & permissions'), 'roles-permissions');
  }

  section('PARSER: THE REAL DOCUMENTS');

  {
    // Every catalogued file must exist and parse into something substantial.
    const onDisk = new Set(readdirSync('docs').filter((f) => f.endsWith('.md')));
    let missing = 0;
    let thin = 0;

    for (const entry of DOC_ENTRIES) {
      if (!onDisk.has(entry.file)) {
        console.log(`        catalogue names a file that is not there: ${entry.file}`);
        missing += 1;
        continue;
      }
      const blocks = parseMarkdown(readFileSync(`docs/${entry.file}`, 'utf8'));
      const text = blocksToText(blocks);
      if (blocks.length < 5 || text.length < 200) thin += 1;
    }

    check('every catalogued document exists on disk', missing, 0);
    check('and every one parses into real content', thin, 0);
  }

  {
    // Nothing may be lost: a document with no blocks would render blank.
    const empty = DOC_ENTRIES.filter(
      (entry) => parseMarkdown(readFileSync(`docs/${entry.file}`, 'utf8')).length === 0,
    );
    check('no document parses to nothing', empty.length, 0);
  }

  section('ANCHORS ARE UNIQUE');

  {
    // Two headings with the same words would otherwise share a DOM id, so a
    // link to the second would silently land on the first - and React would
    // warn about duplicate keys in the contents panel.
    let clashing = 0;
    for (const entry of DOC_ENTRIES) {
      const blocks = parseMarkdown(readFileSync(`docs/${entry.file}`, 'utf8'));
      const slugs = blocks.filter((b) => b.type === 'heading').map((b) => b.slug);
      if (new Set(slugs).size !== slugs.length) {
        clashing += 1;
        console.log(`        duplicate anchors in ${entry.file}`);
      }
    }
    check('every anchor within a document is unique', clashing, 0);

    const repeated = parseMarkdown('## Offboarding\n\ntext\n\n## Offboarding\n\nmore\n');
    const slugs = repeated.filter((b) => b.type === 'heading').map((b) => b.slug);
    check('a repeated heading gets a distinct anchor', slugs, ['offboarding', 'offboarding-1']);
  }

  section('EVERY ANCHOR RESOLVES');

  {
    /**
     * The documents link to each other by heading anchor. An anchor that does
     * not resolve is a link that silently lands at the top of a long page, so
     * it is checked here rather than trusted.
     */
    const slugsByFile = new Map();
    for (const entry of DOC_ENTRIES) {
      const blocks = parseMarkdown(readFileSync(`docs/${entry.file}`, 'utf8'));
      slugsByFile.set(
        entry.file.toLowerCase(),
        new Set(blocks.filter((b) => b.type === 'heading').map((b) => b.slug)),
      );
    }

    let broken = 0;
    let checked = 0;
    for (const entry of DOC_ENTRIES) {
      const source = readFileSync(`docs/${entry.file}`, 'utf8');
      for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = match[1];
        if (/^https?:/.test(href)) continue;
        const [file, anchor] = href.split('#');
        if (!anchor) continue;

        const targetFile = (file === '' ? entry.file : file).toLowerCase();
        const known = slugsByFile.get(targetFile);
        // A link to a file outside the catalogue is not this check's business.
        if (!known) continue;

        checked += 1;
        if (!known.has(anchor)) {
          broken += 1;
          console.log(`        ${entry.file} -> ${href}`);
        }
      }
    }

    truthy('there are anchored links to check', checked > 0);
    check('every anchor resolves to a real heading', broken, 0);
  }

  section('SIGNING IN');

  {
    adminCookie = await login('admin@hrms.local', 'Admin@12345');
    managerCookie = await login('manager@hrms.local', 'Manager@12345');
    employeeCookie = await login('employee@hrms.local', 'Employee@12345');
    truthy('three sessions', adminCookie && managerCookie && employeeCookie);
  }

  section('THE CATALOGUE');

  {
    const anon = await fetch(`${BASE}/docs`);
    check('the help centre needs a session', anon.status, 401);

    const admin = await api(adminCookie, '/docs');
    check('an administrator gets the catalogue', admin.status, 200);
    truthy('grouped into categories', admin.body.data.categories.length >= 5);

    const slugs = admin.body.data.categories.flatMap((c) => c.documents.map((d) => d.slug));
    check('every catalogued document is offered', slugs.length, DOC_ENTRIES.length);
    truthy('and it carries the module help map', admin.body.data.moduleHelp.payroll === 'payroll');

    const emptyCategories = admin.body.data.categories.filter((c) => c.documents.length === 0);
    check('no empty category is shown', emptyCategories.length, 0);
  }

  section('ROLE-BASED ACCESS');

  {
    const employee = await api(employeeCookie, '/docs');
    check('an employee gets a catalogue', employee.status, 200);

    const employeeSlugs = employee.body.data.categories.flatMap((c) =>
      c.documents.map((d) => d.slug),
    );
    truthy('with the general guides', employeeSlugs.includes('employee-guide'));
    truthy('and troubleshooting', employeeSlugs.includes('troubleshooting'));

    // The restricted ones are absent, not listed-and-locked: advertising a
    // document and then refusing it tells somebody where to look.
    check('but not the administrator manual', employeeSlugs.includes('admin-manual'), false);
    check('nor the payroll guide', employeeSlugs.includes('payroll'), false);
    check('nor the device guide', employeeSlugs.includes('devices'), false);
    check('nor the quick start', employeeSlugs.includes('quick-start'), false);
    check('nor any technical reference', employeeSlugs.includes('architecture'), false);

    // And asking directly is refused the same way an unknown slug is, so the
    // catalogue cannot be enumerated by probing.
    const direct = await api(employeeCookie, '/docs/admin-manual');
    check('asking for it directly is refused', direct.status, 404);
    const unknown = await api(employeeCookie, '/docs/no-such-document');
    check('exactly as an unknown slug is', unknown.status, direct.status);
    check('with the same body', unknown.body.error.code, direct.body.error.code);

    const payroll = await api(employeeCookie, '/docs/payroll');
    check('the payroll guide is refused too', payroll.status, 404);
    check('and leaks no content', /basic salary|daily_rate/i.test(payroll.text), false);
  }

  {
    const manager = await api(managerCookie, '/docs');
    const managerSlugs = manager.body.data.categories.flatMap((c) =>
      c.documents.map((d) => d.slug),
    );
    truthy('a manager gets the manager guide', managerSlugs.includes('manager-guide'));
    check('but not the administrator manual', managerSlugs.includes('admin-manual'), false);
    check('nor payroll', managerSlugs.includes('payroll'), false);

    const managerGuide = await api(managerCookie, '/docs/manager-guide');
    check('and can open theirs', managerGuide.status, 200);

    const employeeAtManagerGuide = await api(employeeCookie, '/docs/manager-guide');
    check('while an employee cannot', employeeAtManagerGuide.status, 404);
  }

  {
    const admin = await api(adminCookie, '/docs/admin-manual');
    check('an administrator can open the manual', admin.status, 200);
    truthy('and it has content', admin.body.data.blocks.length > 50);
  }

  section('THE VIEWER');

  {
    const doc = await api(adminCookie, '/docs/attendance');
    check('a document loads', doc.status, 200);
    check('with its title', doc.body.data.title, 'Attendance guide');
    truthy('and its category', doc.body.data.categoryTitle.length > 0);
    truthy('a substantial block tree', doc.body.data.blocks.length > 40);

    const kinds = new Set(doc.body.data.blocks.map((b) => b.type));
    truthy('with headings', kinds.has('heading'));
    truthy('paragraphs', kinds.has('paragraph'));
    truthy('lists', kinds.has('list'));
    truthy('tables', kinds.has('table'));
    truthy('code blocks', kinds.has('code'));

    truthy('a contents list', doc.body.data.headings.length > 5);
    truthy('and neighbours to navigate to', doc.body.data.next !== null);
  }

  {
    // Links between documents become in-app routes rather than dead file paths.
    const doc = await api(adminCookie, '/docs/overview');
    const links = [];
    const walk = (blocks) => {
      for (const block of blocks) {
        for (const node of block.content ?? []) if (node.type === 'link') links.push(node);
        for (const row of block.rows ?? []) {
          for (const cell of row) for (const node of cell) if (node.type === 'link') links.push(node);
        }
        if (block.blocks) walk(block.blocks);
      }
    };
    walk(doc.body.data.blocks);

    truthy('the index carries links', links.length > 3);
    const internal = links.filter((l) => !l.external);
    check(
      'every internal link points at an in-app route',
      internal.every((l) => l.href.startsWith('/help/') || l.href.startsWith('#')),
      true,
    );
    check(
      'and none still points at a markdown file',
      internal.some((l) => l.href.endsWith('.md')),
      false,
    );
  }

  {
    // A link to a document the reader may not open is flattened rather than
    // left pointing at a 404.
    const doc = await api(employeeCookie, '/docs/overview');
    const links = [];
    const walk = (blocks) => {
      for (const block of blocks) {
        for (const node of block.content ?? []) if (node.type === 'link') links.push(node);
        for (const row of block.rows ?? []) {
          for (const cell of row) for (const node of cell) if (node.type === 'link') links.push(node);
        }
        if (block.blocks) walk(block.blocks);
      }
    };
    walk(doc.body.data.blocks);

    check(
      'an employee is given no link into a restricted document',
      links.some((l) => /\/help\/(admin-manual|payroll|devices|quick-start)/.test(l.href)),
      false,
    );
  }

  section('PATH TRAVERSAL');

  {
    // A slug is a key into the catalogue, never a path. None of these is a key.
    const attempts = [
      '../../../.env',
      '..%2f..%2f.env',
      '....//....//.env',
      '%2e%2e%2f%2e%2e%2fpackage.json',
      'docs/../../.env',
      '/etc/passwd',
      'HRMS-ADMIN-MANUAL.md',
      'HRMS-ADMIN-MANUAL',
      '.env',
      'package.json',
    ];

    let leaked = 0;
    let notFound = 0;
    for (const attempt of attempts) {
      const response = await api(adminCookie, `/docs/${encodeURIComponent(attempt)}`);
      if (response.status === 200) leaked += 1;
      else notFound += 1;
      if (/DATABASE_URL|SESSION_SECRET|passwordHash|"dependencies"/.test(response.text)) {
        leaked += 1;
        console.log(`        LEAK via ${attempt}`);
      }
    }
    check('no traversal attempt returns a document', leaked, 0);
    check('every one is refused', notFound, attempts.length);
  }

  {
    // Even a file that genuinely exists in docs/ is unreachable unless the
    // catalogue names it, because the filename is not the key.
    const byFilename = await api(adminCookie, '/docs/architecture.md');
    check('a real filename is still not a slug', byFilename.status, 404);
  }

  section('SEARCH');

  {
    const terms = ['payroll', 'attendance', 'ZKTeco', 'ADMS', 'leave', 'employee', 'device', 'approval', 'payslip', 'settings'];
    let empty = 0;
    for (const term of terms) {
      const result = await api(adminCookie, `/docs/search?q=${encodeURIComponent(term)}`);
      if (result.status !== 200 || result.body.data.length === 0) {
        empty += 1;
        console.log(`        no hits for "${term}"`);
      }
    }
    check('every expected term finds something', empty, 0);
  }

  {
    const result = await api(adminCookie, '/docs/search?q=ZKTeco');
    truthy('search returns hits', result.body.data.length > 0);
    check('best match first', result.body.data[0].slug, 'devices');
    truthy('with excerpts', result.body.data[0].matches.length > 0);
    truthy('and the heading each sits under', result.body.data[0].matches.some((m) => m.heading));

    const short = await api(adminCookie, '/docs/search?q=a');
    check('a one-character search is refused', short.status, 422);
  }

  {
    // Search is narrowed the same way the catalogue is.
    const admin = await api(adminCookie, '/docs/search?q=payslip');
    const employee = await api(employeeCookie, '/docs/search?q=payslip');

    truthy('an administrator finds payroll material', admin.body.data.some((h) => h.slug === 'payroll'));
    check(
      'an employee does not',
      employee.body.data.some((h) => h.slug === 'payroll'),
      false,
    );

    const secret = await api(employeeCookie, '/docs/search?q=push token');
    check(
      'and cannot reach device security material through search',
      secret.body.data.some((h) => h.slug === 'devices'),
      false,
    );
  }

  section('NO SECRETS ARE SERVED');

  {
    // The catalogue names only documentation, but assert it: an entry added
    // carelessly later should fail here rather than in production.
    let exposed = 0;
    for (const entry of DOC_ENTRIES) {
      const doc = await api(adminCookie, `/docs/${entry.slug}`);
      if (doc.status !== 200) continue;
      if (/SESSION_SECRET=|DATABASE_URL=postgres|BEGIN (RSA )?PRIVATE KEY|\$argon2/.test(doc.text)) {
        exposed += 1;
        console.log(`        ${entry.slug} appears to contain a real secret`);
      }
    }
    check('no document carries a credential', exposed, 0);
  }

  section('EXISTING MODULES ARE UNAFFECTED');

  {
    const checks = [
      ['/employees?limit=1', 200],
      ['/attendance?limit=1', 200],
      ['/payroll/runs', 200],
      ['/users', 200],
      ['/roles', 200],
      ['/leave/requests?limit=1', 200],
      ['/timesheets?limit=1', 200],
      ['/attendance/devices', 200],
    ];
    let wrong = 0;
    for (const [path, expected] of checks) {
      const result = await api(adminCookie, path);
      if (result.status !== expected) {
        wrong += 1;
        console.log(`        ${path} -> ${result.status}, expected ${expected}`);
      }
    }
    check('every existing module still answers', wrong, 0);

    const iclock = await fetch('http://127.0.0.1:4000/iclock/cdata?SN=NOPE');
    check('the device push endpoint still refuses an unknown device', iclock.status, 401);

    const employeePayroll = await api(employeeCookie, '/payroll/runs');
    check('and an employee still cannot reach payroll', employeePayroll.status, 403);
  }
} catch (error) {
  fail += 1;
  console.error('\nSUITE ABORTED:', error);
}

console.log('\n################ SUMMARY ################');
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
