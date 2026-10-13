import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CASE_ATTACHMENT_MAX_BYTES,
  CASE_ATTACHMENT_MAX_PER_CASE,
  PERMISSIONS,
  type DataScope,
  type Permission,
} from '@hrms/shared';

/**
 * Files on a case.
 *
 * An attachment is the most sensitive thing this module holds - a payslip, a
 * medical bill, a screenshot of somebody's inbox - and it is the one thing an
 * employee can reach by a URL that carries two ids. So these tests are mostly
 * about the ways somebody could ask for one that is not theirs:
 *
 *   - a valid attachment id on a case that is not yours;
 *   - a valid attachment id from another case, paired with your own case id;
 *   - the id of a file attached to a staff-only note on your OWN case.
 *
 * All three answer 404. Neither id is load-bearing on its own, which is the
 * whole point of putting both in the path and checking both.
 *
 * The rest pins the upload rules that the browser cannot be trusted with: what
 * a file IS is read from its bytes and not from its Content-Type, the name is a
 * label and never a path, and the object key is generated here.
 */

const COMPANY = 'company-1';
const ME = { id: 'emp-me', userId: 'user-me' };
const COLLEAGUE = { id: 'emp-colleague', userId: 'user-colleague' };

/** Real leading bytes, because the sniffer reads them. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 1)]);
const TEXT = Buffer.from('date,amount\n2026-09-01,1200\n', 'utf8');
/** A Windows executable. The thing the allow-list exists to refuse. */
const EXE = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(64, 0)]);
/** A ZIP header, which is what a .docx is - and what an arbitrary archive is. */
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 3)]);

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn() },
  case: { findFirst: vi.fn() },
  caseMessage: { findFirst: vi.fn() },
  caseAttachment: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
}));

const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));

vi.mock('../../core/db.js', () => ({ prisma: db }));
vi.mock('../../core/storage/object-store.js', () => ({
  putObject: vi.fn(async (key: string, data: Buffer) => {
    store.objects.set(key, data);
  }),
  getObject: vi.fn(async (key: string) => store.objects.get(key) ?? null),
  deleteObject: vi.fn(async (key: string) => store.objects.delete(key)),
}));

const { matches } = await import('./case-store.test-kit.js');
const { caseAttachmentRoutes } = await import('./case-attachments.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const EMPLOYEE: Permission[] = [
  PERMISSIONS.CASE_READ_OWN,
  PERMISSIONS.CASE_CREATE,
  PERMISSIONS.CASE_REPLY_OWN,
  PERMISSIONS.CASE_REOPEN_OWN,
];

async function appAs(
  permissions: Permission[] = EMPLOYEE,
  userId: string = ME.userId,
  dataScope: DataScope = 'OWN',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId,
      companyId: COMPANY,
      email: 'someone@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(caseAttachmentRoutes, { prefix: '/cases' });
  await app.ready();
  return app;
}

/** The two cases every test below is about the gap between. */
const CASES = [
  { id: 'case-mine', companyId: COMPANY, requesterEmployeeId: ME.id, departmentId: 'dep-it', status: 'OPEN', caseNumber: 'CASE-2026-000001' },
  { id: 'case-mine-2', companyId: COMPANY, requesterEmployeeId: ME.id, departmentId: 'dep-it', status: 'OPEN', caseNumber: 'CASE-2026-000002' },
  { id: 'case-theirs', companyId: COMPANY, requesterEmployeeId: COLLEAGUE.id, departmentId: 'dep-it', status: 'OPEN', caseNumber: 'CASE-2026-000003' },
  { id: 'case-closed', companyId: COMPANY, requesterEmployeeId: ME.id, departmentId: 'dep-it', status: 'CLOSED', caseNumber: 'CASE-2026-000004' },
  // Filed with Finance, which the IT agent below cannot work.
  { id: 'case-finance', companyId: COMPANY, requesterEmployeeId: COLLEAGUE.id, departmentId: 'dep-fin', status: 'OPEN', caseNumber: 'CASE-2026-000005' },
];

/** The member of the desk: IT, and therefore not Finance. */
const AGENT = { id: 'emp-agent', userId: 'user-agent', departmentId: 'dep-it' };

const DESK: Permission[] = [
  PERMISSIONS.CASE_READ_DEPARTMENT,
  PERMISSIONS.CASE_RESPOND,
  PERMISSIONS.CASE_NOTE_INTERNAL,
];

interface AttachmentRow {
  id: string;
  companyId: string;
  caseId: string;
  messageId: string | null;
  fileName: string;
  contentType: string;
  objectKey: string;
  isInternal: boolean;
  createdAt: Date;
}

let attachments: AttachmentRow[] = [];

const json = (response: { payload: string }) => JSON.parse(response.payload) as Record<string, never>;

beforeEach(() => {
  vi.clearAllMocks();
  store.objects.clear();

  attachments = [
    {
      id: 'att-mine',
      companyId: COMPANY,
      caseId: 'case-mine',
      messageId: null,
      fileName: 'payslip.pdf',
      contentType: 'application/pdf',
      objectKey: 'case-attachments/company-1/case-mine/aaa.pdf',
      isInternal: false,
      createdAt: new Date('2026-09-01T09:00:00.000Z'),
    },
    {
      id: 'att-theirs',
      companyId: COMPANY,
      caseId: 'case-theirs',
      messageId: null,
      fileName: 'their-bank-letter.pdf',
      contentType: 'application/pdf',
      objectKey: 'case-attachments/company-1/case-theirs/bbb.pdf',
      isInternal: false,
      createdAt: new Date('2026-09-01T09:00:00.000Z'),
    },
    {
      id: 'att-internal',
      companyId: COMPANY,
      // On the caller's OWN case, but attached to a staff-only note.
      caseId: 'case-mine',
      messageId: 'msg-internal',
      fileName: 'triage-notes.txt',
      contentType: 'text/plain',
      objectKey: 'case-attachments/company-1/case-mine/ccc.txt',
      isInternal: true,
      createdAt: new Date('2026-09-01T09:00:00.000Z'),
    },
  ];

  for (const row of attachments) store.objects.set(row.objectKey, PDF);

  db.employee.findFirst.mockImplementation((args: { where: { userId?: string } }) => {
    const match = [ME, COLLEAGUE, AGENT].find((e) => e.userId === args.where.userId);
    return Promise.resolve(
      match ? { id: match.id, departmentId: 'departmentId' in match ? match.departmentId : null } : null,
    );
  });

  /*
   * Both real lookups, honoured rather than stubbed. The requester's is id +
   * company + requester; the desk's is id + company + the departments that
   * caller may work. A route that dropped either narrowing would start finding
   * rows here, which is the whole reason these are evaluated instead of faked.
   */
  db.case.findFirst.mockImplementation((args: { where: Record<string, unknown> }) => {
    const where = args.where;

    if (Array.isArray(where.AND)) {
      // The desk's scope clause is evaluated as written, OR and all.
      return Promise.resolve(
        CASES.map((row) => ({ assignedUserId: null, ...row })).find((row) => matches(row, where)) ??
          null,
      );
    }

    return Promise.resolve(
      CASES.find(
        (row) =>
          row.id === where.id &&
          row.companyId === where.companyId &&
          row.requesterEmployeeId === where.requesterEmployeeId,
      ) ?? null,
    );
  });

  db.caseAttachment.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
    Promise.resolve(
      attachments.find(
        (row) =>
          row.id === args.where.id &&
          row.caseId === args.where.caseId &&
          row.companyId === args.where.companyId &&
          // Absent on the desk's lookup, which is what lets it read a note's
          // file; present and false on the employee's, which is what stops it.
          (args.where.isInternal === undefined || row.isInternal === args.where.isInternal),
      ) ?? null,
    ),
  );

  db.caseMessage.findFirst.mockResolvedValue(null);
  db.caseAttachment.count.mockResolvedValue(0);
  db.caseAttachment.create.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: 'att-new',
      fileName: args.data.fileName,
      contentType: args.data.contentType,
      sizeBytes: args.data.sizeBytes,
      createdAt: new Date('2026-09-16T09:00:00.000Z'),
    }),
  );
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
});

// -----------------------------------------------------------------------------

describe('uploading', () => {
  const upload = (
    app: FastifyInstance,
    caseId: string,
    payload: Buffer,
    contentType: string,
    query = '',
  ) =>
    app.inject({
      method: 'POST',
      url: `/cases/${caseId}/attachments${query}`,
      headers: { 'content-type': contentType },
      payload,
    });

  it('stores a file on the caller&apos;s own case', async () => {
    const app = await appAs();
    const response = await upload(app, 'case-mine', PNG, 'image/png', '?filename=screenshot.png');

    expect(response.statusCode).toBe(201);
    expect(json(response).data).toMatchObject({
      fileName: 'screenshot.png',
      contentType: 'image/png',
      sizeBytes: PNG.length,
    });
  });

  it('names the object itself, scoped by company and case', async () => {
    const app = await appAs();
    await upload(app, 'case-mine', PNG, 'image/png', '?filename=../../etc/passwd');

    const key = (db.caseAttachment.create.mock.calls[0]?.[0] as { data: { objectKey: string } })
      .data.objectKey;

    // Generated from a uuid. Nothing the client sent appears in it, so a
    // hostile filename has nowhere to land.
    expect(key).toMatch(
      /^case-attachments\/company-1\/case-mine\/[0-9a-f-]{36}\.png$/,
    );
    expect(key).not.toContain('passwd');
    expect(store.objects.has(key)).toBe(true);
  });

  it('keeps the filename as a label, sanitised', async () => {
    const app = await appAs();
    await upload(app, 'case-mine', PDF, 'application/pdf', '?filename=../../etc/passwd');

    expect(db.caseAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fileName: 'etc-passwd' }) }),
    );
  });

  it('falls back to a generated name when none was sent', async () => {
    const app = await appAs();
    await upload(app, 'case-mine', PDF, 'application/pdf');

    expect(db.caseAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fileName: 'attachment.pdf' }) }),
    );
  });

  it('believes the bytes, not the Content-Type', async () => {
    const app = await appAs();
    // A PNG announced as a PDF is stored - and later served - as a PNG.
    const response = await upload(app, 'case-mine', PNG, 'application/pdf', '?filename=a.pdf');

    expect(response.statusCode).toBe(201);
    expect(db.caseAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contentType: 'image/png' }) }),
    );
  });

  it('accepts a plain text or CSV file, which has no signature to check', async () => {
    const app = await appAs();

    const csv = await upload(app, 'case-mine', TEXT, 'text/csv', '?filename=hours.csv');
    expect(csv.statusCode).toBe(201);
    expect(json(csv).data).toMatchObject({ contentType: 'text/csv' });

    const txt = await upload(app, 'case-mine', TEXT, 'text/plain', '?filename=notes.txt');
    expect(json(txt).data).toMatchObject({ contentType: 'text/plain' });
  });

  it('refuses an executable and an archive, however they are announced', async () => {
    const app = await appAs();

    for (const [bytes, announced] of [
      [EXE, 'application/pdf'],
      [EXE, 'text/plain'],
      [ZIP, 'application/pdf'],
      // A .docx is a ZIP, and a ZIP header proves nothing about what is inside.
      [ZIP, 'text/csv'],
    ] as Array<[Buffer, string]>) {
      const response = await upload(app, 'case-mine', bytes, announced, '?filename=x');
      expect(response.statusCode).toBe(422);
    }

    expect(db.caseAttachment.create).not.toHaveBeenCalled();
  });

  it('refuses an empty body', async () => {
    const app = await appAs();
    const response = await upload(app, 'case-mine', Buffer.alloc(0), 'application/pdf');

    expect(response.statusCode).toBe(422);
  });

  it('refuses a file over the size limit', async () => {
    const app = await appAs();
    const huge = Buffer.concat([PDF, Buffer.alloc(CASE_ATTACHMENT_MAX_BYTES)]);

    const response = await upload(app, 'case-mine', huge, 'application/pdf', '?filename=big.pdf');

    expect(response.statusCode).toBe(413);
    expect(db.caseAttachment.create).not.toHaveBeenCalled();
  });

  it('refuses once the case has reached its total', async () => {
    db.caseAttachment.count.mockResolvedValue(CASE_ATTACHMENT_MAX_PER_CASE);

    const app = await appAs();
    const response = await upload(app, 'case-mine', PDF, 'application/pdf', '?filename=a.pdf');

    expect(response.statusCode).toBe(409);
    expect(db.caseAttachment.create).not.toHaveBeenCalled();
  });

  it('cannot attach anything to a colleague&apos;s case', async () => {
    const app = await appAs();
    const response = await upload(app, 'case-theirs', PDF, 'application/pdf', '?filename=a.pdf');

    expect(response.statusCode).toBe(404);
    expect(db.caseAttachment.create).not.toHaveBeenCalled();
    expect(store.objects.size).toBe(3); // the three fixtures, and nothing new
  });

  it('cannot attach to a closed case', async () => {
    const app = await appAs();
    const response = await upload(app, 'case-closed', PDF, 'application/pdf', '?filename=a.pdf');

    expect(response.statusCode).toBe(409);
  });

  it('refuses a message id that belongs to another case', async () => {
    // The lookup carries this case's id, so a foreign message id finds nothing.
    db.caseMessage.findFirst.mockResolvedValue(null);

    const app = await appAs();
    const response = await upload(
      app,
      'case-mine',
      PDF,
      'application/pdf',
      '?filename=a.pdf&messageId=msg-from-another-case',
    );

    expect(response.statusCode).toBe(404);
    expect(db.caseMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ caseId: 'case-mine', isInternal: false }),
      }),
    );
    expect(db.caseAttachment.create).not.toHaveBeenCalled();
  });

  it('writes an audit entry naming the file but never its contents', async () => {
    const app = await appAs();
    await upload(app, 'case-mine', TEXT, 'text/csv', '?filename=hours.csv');

    const audit = db.auditLog.create.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({ action: 'case.attachment.add', entityType: 'Case' });
    expect(JSON.stringify(audit.data)).toContain('hours.csv');
    expect(JSON.stringify(audit.data)).not.toContain('2026-09-01,1200');
    // The storage key is not a fact about the case, and is not in the trail.
    expect(JSON.stringify(audit.data)).not.toContain('case-attachments/');
  });

  it('needs a grant that could have produced the thing it is attached to', async () => {
    const none = await appAs([]);
    expect((await upload(none, 'case-mine', PDF, 'application/pdf')).statusCode).toBe(403);

    // Read-only is not enough to add a file.
    const reader = await appAs([PERMISSIONS.CASE_READ_OWN]);
    expect((await upload(reader, 'case-mine', PDF, 'application/pdf')).statusCode).toBe(403);

    const replier = await appAs([PERMISSIONS.CASE_REPLY_OWN]);
    expect((await upload(replier, 'case-mine', PDF, 'application/pdf')).statusCode).toBe(201);
  });
});

describe('downloading', () => {
  const get = (app: FastifyInstance, caseId: string, attachmentId: string) =>
    app.inject({ method: 'GET', url: `/cases/${caseId}/attachments/${attachmentId}` });

  it('serves the caller&apos;s own attachment', async () => {
    const app = await appAs();
    const response = await get(app, 'case-mine', 'att-mine');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.rawPayload.equals(PDF)).toBe(true);
  });

  it('refuses a colleague&apos;s attachment on their own case', async () => {
    const app = await appAs();
    const response = await get(app, 'case-theirs', 'att-theirs');

    expect(response.statusCode).toBe(404);
  });

  it('refuses a colleague&apos;s attachment id paired with the caller&apos;s own case id', async () => {
    /*
     * The interesting half of the IDOR story. The case id passes - it really is
     * the caller's - so the defence rests entirely on the attachment lookup
     * carrying that same case id. Without it this would hand over the file.
     */
    const app = await appAs();
    const response = await get(app, 'case-mine', 'att-theirs');

    expect(response.statusCode).toBe(404);
  });

  it('refuses the file attached to a staff-only note on the caller&apos;s OWN case', async () => {
    const app = await appAs();
    const response = await get(app, 'case-mine', 'att-internal');

    expect(response.statusCode).toBe(404);
  });

  it('is not reachable by a colleague even with both real ids', async () => {
    const app = await appAs(EMPLOYEE, COLLEAGUE.userId);
    const response = await get(app, 'case-mine', 'att-mine');

    expect(response.statusCode).toBe(404);
  });

  it('does not widen for a company-wide data scope', async () => {
    const app = await appAs(EMPLOYEE, ME.userId, 'ALL');
    expect((await get(app, 'case-theirs', 'att-theirs')).statusCode).toBe(404);
  });

  it('needs case.read.own', async () => {
    const app = await appAs([PERMISSIONS.CASE_CREATE]);
    expect((await get(app, 'case-mine', 'att-mine')).statusCode).toBe(403);
  });

  it('sends a PDF as a download and an image inline, both with nosniff', async () => {
    attachments.push({
      id: 'att-image',
      companyId: COMPANY,
      caseId: 'case-mine',
      messageId: null,
      fileName: 'screenshot.png',
      contentType: 'image/png',
      objectKey: 'case-attachments/company-1/case-mine/ddd.png',
      isInternal: false,
      createdAt: new Date('2026-09-01T09:00:00.000Z'),
    });
    store.objects.set('case-attachments/company-1/case-mine/ddd.png', PNG);

    const app = await appAs();

    const pdf = await get(app, 'case-mine', 'att-mine');
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="payslip.pdf"');
    expect(pdf.headers['x-content-type-options']).toBe('nosniff');
    expect(String(pdf.headers['cache-control'])).toContain('private');

    const image = await get(app, 'case-mine', 'att-image');
    expect(image.headers['content-disposition']).toBe('inline; filename="screenshot.png"');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
  });

  it('reports a file the store has lost as missing rather than crashing', async () => {
    store.objects.delete('case-attachments/company-1/case-mine/aaa.pdf');

    const app = await appAs();
    expect((await get(app, 'case-mine', 'att-mine')).statusCode).toBe(404);
  });

  it('answers 304 when the browser already has it', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'GET',
      url: '/cases/case-mine/attachments/att-mine',
      headers: { 'if-none-match': '"att-mine"' },
    });

    expect(response.statusCode).toBe(304);
  });
});

// -----------------------------------------------------------------------------

/**
 * The desk's half of the same two routes.
 *
 * Same bytes, same sniffing, same ceiling - the differences are exactly two,
 * and both are tested here rather than assumed: the case is reached through the
 * caller's queues instead of through their own employee id, and an internal
 * file is visible. Everything else is the shared routine, and a test that
 * re-asserted the sniffing here would only be testing the same function twice.
 */
describe('the desk and its files', () => {
  it('reads a file on a colleague\'s case in its own queue', async () => {
    const app = await appAs(DESK, AGENT.userId);

    const response = await app.inject({
      method: 'GET',
      url: '/cases/queue/case-theirs/attachments/att-theirs',
    });

    expect(response.statusCode).toBe(200);
  });

  it('cannot read a file on a case in another department', async () => {
    const app = await appAs(DESK, AGENT.userId);

    const response = await app.inject({
      method: 'GET',
      url: '/cases/queue/case-finance/attachments/att-theirs',
    });

    expect(response.statusCode).toBe(404);
  });

  it('reads the file on an internal note, which the requester cannot', async () => {
    const desk = await appAs(DESK, AGENT.userId);
    const employee = await appAs();

    const deskResponse = await desk.inject({
      method: 'GET',
      url: '/cases/queue/case-mine/attachments/att-internal',
    });
    const employeeResponse = await employee.inject({
      method: 'GET',
      url: '/cases/case-mine/attachments/att-internal',
    });

    expect(deskResponse.statusCode).toBe(200);
    // On their own case, holding the id, and still 404: the file is absent from
    // the query rather than withheld after it.
    expect(employeeResponse.statusCode).toBe(404);
  });

  it('marks a file internal when the note it belongs to is', async () => {
    const app = await appAs(DESK, AGENT.userId);

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-theirs/attachments?internal=true&filename=trace.txt',
      headers: { 'content-type': 'text/plain' },
      payload: TEXT,
    });

    expect(response.statusCode).toBe(201);
    const created = db.caseAttachment.create.mock.calls[0]?.[0] as { data: { isInternal: boolean } };
    expect(created.data.isInternal).toBe(true);
  });

  it('refuses an internal file from somebody who cannot write a note', async () => {
    const app = await appAs([PERMISSIONS.CASE_READ_DEPARTMENT, PERMISSIONS.CASE_RESPOND], AGENT.userId);

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-theirs/attachments?internal=true',
      headers: { 'content-type': 'text/plain' },
      payload: TEXT,
    });

    expect(response.statusCode).toBe(403);
    expect(db.caseAttachment.create).not.toHaveBeenCalled();
  });

  it('cannot upload to a case in another department', async () => {
    const app = await appAs(DESK, AGENT.userId);

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-finance/attachments',
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });

    expect(response.statusCode).toBe(404);
    expect(db.caseAttachment.create).not.toHaveBeenCalled();
  });

  it('is closed to an employee who is not on the desk at all', async () => {
    const app = await appAs();

    const upload = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-mine/attachments',
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });
    const download = await app.inject({
      method: 'GET',
      url: '/cases/queue/case-mine/attachments/att-mine',
    });

    expect(upload.statusCode).toBe(403);
    expect(download.statusCode).toBe(403);
  });
});
