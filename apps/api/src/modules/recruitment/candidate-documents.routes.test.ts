import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_DOCUMENT_MAX_BYTES,
  CANDIDATE_DOCUMENT_MAX_PER_CANDIDATE,
  PERMISSIONS,
  type Permission,
} from '@hrms/shared';

/**
 * Files on a candidate.
 *
 * A CV is the one thing in recruitment that arrives as bytes, and the rules
 * these tests pin are the three that bytes bring with them:
 *
 *   - WHAT A FILE IS, IS READ FROM THE FILE. The Content-Type header is written
 *     by whoever made the request and the filename is a label, so neither
 *     decides anything. An executable announced as a PDF is refused.
 *   - THE NAME NEVER BECOMES A PATH. The object key is generated here from a
 *     UUID and scoped by company and candidate; a hostile filename has nowhere
 *     to land.
 *   - A CONFIDENTIAL FILE IS ABSENT, NOT HIDDEN. A reference check is excluded
 *     by the WHERE clause for anybody without `candidate.manage`, so the count
 *     they see matches the list they get and holding the id of one buys
 *     nothing.
 *
 * And the two-id rule the case attachments established: both the candidate id
 * and the document id are in the path, and BOTH are checked, so neither is
 * load-bearing on its own.
 */

const kit = await vi.hoisted(async () => import('./recruitment.test-kit.js'));
const db = kit.recruitmentDb();

const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));

vi.mock('../../core/db.js', () => ({ prisma: db }));
vi.mock('../../core/storage/object-store.js', () => ({
  putObject: vi.fn(async (key: string, data: Buffer) => {
    store.objects.set(key, data);
  }),
  getObject: vi.fn(async (key: string) => store.objects.get(key) ?? null),
  deleteObject: vi.fn(async (key: string) => store.objects.delete(key)),
}));

const { candidateDocumentRoutes } = await import('./candidate-documents.routes.js');
const objectStore = await import('../../core/storage/object-store.js');
const { COMPANY, HR, INTERVIEWER, appAs, auditActions, documentRow, useRecruitmentDb, wirePeople } =
  kit;

const PREFIX = '/recruitment/candidates';

/** Reads candidates, manages none - so confidential files are not theirs. */
const READER: Permission[] = [PERMISSIONS.RECRUITMENT_READ, PERMISSIONS.CANDIDATE_READ];

/** Real leading bytes, because the sniffer reads them. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
/** A Windows executable, announced as a PDF. The thing the allow-list refuses. */
const EXE = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(64, 0)]);

beforeEach(() => {
  vi.clearAllMocks();
  store.objects.clear();
  useRecruitmentDb(db);
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.candidate.findFirst.mockResolvedValue({
    id: 'cand-1',
    fullName: 'Muhammad Ali',
    reference: 'CAN-0001',
  });
  db.candidateDocument.count.mockResolvedValue(2);
  db.candidateDocument.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    ...documentRow(),
    ...args.data,
    id: 'doc-new',
    createdAt: kit.NOW,
  }));
});

describe('who reaches this plugin at all', () => {
  it('refuses an interviewer, who holds no candidate grant', async () => {
    const app = await appAs(candidateDocumentRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: kit.AHMED.userId,
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/cand-1/documents` });

    expect(response.statusCode).toBe(403);
    expect(db.candidateDocument.findMany).not.toHaveBeenCalled();
  });

  it('lets a reader list, and refuses them the upload', async () => {
    db.candidateDocument.findMany.mockResolvedValue([documentRow()]);

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: READER });

    const list = await app.inject({ method: 'GET', url: `${PREFIX}/cand-1/documents` });
    expect(list.statusCode).toBe(200);

    const upload = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/documents?filename=cv.pdf`,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });
    expect(upload.statusCode).toBe(403);
    expect(objectStore.putObject).not.toHaveBeenCalled();
  });
});

describe('the shelf', () => {
  it('excludes confidential files from the QUERY for a plain reader', async () => {
    db.candidateDocument.findMany.mockResolvedValue([documentRow()]);

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: READER });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/cand-1/documents` });

    expect(response.statusCode).toBe(200);
    expect(db.candidateDocument.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      candidateId: 'cand-1',
      companyId: COMPANY,
      isConfidential: false,
    });
  });

  it('asks for all of them for somebody who manages candidates', async () => {
    db.candidateDocument.findMany.mockResolvedValue([
      documentRow(),
      documentRow({ id: 'doc-2', fileName: 'reference-check.pdf', isConfidential: true }),
    ]);

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/cand-1/documents` });

    expect(response.statusCode).toBe(200);
    expect(db.candidateDocument.findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty(
      'isConfidential',
    );
    expect(response.json().data).toHaveLength(2);
  });

  it('carries the uploader’s name and never the object key', async () => {
    db.candidateDocument.findMany.mockResolvedValue([documentRow()]);

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/cand-1/documents` });

    const [document] = response.json().data;
    expect(document.uploadedByName).toBe('Sana Iqbal');
    expect(document).not.toHaveProperty('objectKey');
  });

  it('404s on a candidate belonging to another company', async () => {
    db.candidate.findFirst.mockResolvedValue(null);

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/cand-other/documents` });

    expect(response.statusCode).toBe(404);
    expect(db.candidateDocument.findMany).not.toHaveBeenCalled();
  });
});

describe('uploading one', () => {
  it('stores the bytes under a key it generated, then writes the row', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/documents?filename=muhammad-ali-cv.pdf&type=RESUME`,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });

    expect(response.statusCode).toBe(201);
    const data = db.candidateDocument.create.mock.calls[0]?.[0]?.data;
    expect(data.objectKey).toMatch(
      new RegExp(`^candidate-documents/${COMPANY}/cand-1/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(data.type).toBe('RESUME');
    expect(data.sizeBytes).toBe(PDF.length);
    expect(data.isConfidential).toBe(false);
    // The file first, the row second: a referenced file that was never written
    // is a broken link.
    expect(store.objects.get(data.objectKey)).toEqual(PDF);
  });

  it('reads the type from the bytes, not from the header', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/documents?filename=portfolio.pdf`,
      // A PNG announced as a PDF is stored and served as a PNG.
      headers: { 'content-type': 'application/pdf' },
      payload: PNG,
    });

    expect(response.statusCode).toBe(201);
    const data = db.candidateDocument.create.mock.calls[0]?.[0]?.data;
    expect(data.contentType).toBe('image/png');
    expect(data.objectKey.endsWith('.png')).toBe(true);
  });

  it('refuses an executable however it is announced', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/documents?filename=cv.pdf`,
      headers: { 'content-type': 'application/pdf' },
      payload: EXE,
    });

    expect(response.statusCode).toBe(422);
    expect(objectStore.putObject).not.toHaveBeenCalled();
    expect(db.candidateDocument.create).not.toHaveBeenCalled();
  });

  it('refuses an empty body', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/documents`,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.alloc(0),
    });

    expect(response.statusCode).toBe(422);
    expect(objectStore.putObject).not.toHaveBeenCalled();
  });

  it('refuses one over the size ceiling with a 413', async () => {
    const oversize = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.alloc(CANDIDATE_DOCUMENT_MAX_BYTES, 1),
    ]);

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/documents?filename=huge.pdf`,
      headers: { 'content-type': 'application/pdf' },
      payload: oversize,
    });

    expect(response.statusCode).toBe(413);
    expect(objectStore.putObject).not.toHaveBeenCalled();
  });

  it('refuses one past the per-candidate ceiling', async () => {
    db.candidateDocument.count.mockResolvedValue(CANDIDATE_DOCUMENT_MAX_PER_CANDIDATE);

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/documents?filename=cv.pdf`,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });

    expect(response.statusCode).toBe(409);
    expect(db.candidateDocument.create).not.toHaveBeenCalled();
  });

  it('treats a hostile filename as a label, never as a path', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/documents?filename=${encodeURIComponent('../../etc/passwd')}`,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });

    expect(response.statusCode).toBe(201);
    const data = db.candidateDocument.create.mock.calls[0]?.[0]?.data;
    expect(data.fileName).not.toContain('/');
    expect(data.fileName).not.toContain('..');
    expect(data.objectKey).toMatch(
      new RegExp(`^candidate-documents/${COMPANY}/cand-1/[0-9a-f-]{36}\\.pdf$`),
    );
  });

  it('marks one confidential when the query says so', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/documents?filename=reference-check.pdf&type=OTHER&confidential=true`,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });

    expect(response.statusCode).toBe(201);
    expect(db.candidateDocument.create.mock.calls[0]?.[0]?.data.isConfidential).toBe(true);
  });

  it('audits facts about the file and never the object key', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/documents?filename=cv.pdf`,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });

    expect(auditActions(db)).toEqual(['candidate.updated']);
    const entry = db.auditLog.create.mock.calls[0]?.[0]?.data;
    expect(entry.after).toMatchObject({ fileName: 'cv.pdf', contentType: 'application/pdf' });
    expect(JSON.stringify(entry.after)).not.toContain('candidate-documents/');
  });

  it('404s before it writes anything for a candidate in another company', async () => {
    db.candidate.findFirst.mockResolvedValue(null);

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-other/documents?filename=cv.pdf`,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });

    expect(response.statusCode).toBe(404);
    expect(objectStore.putObject).not.toHaveBeenCalled();
  });
});

describe('downloading one', () => {
  beforeEach(() => {
    store.objects.set('candidates/cand-1/doc-1', PDF);
    db.candidateDocument.findFirst.mockResolvedValue({
      id: 'doc-1',
      fileName: 'muhammad-ali-cv.pdf',
      contentType: 'application/pdf',
      objectKey: 'candidates/cand-1/doc-1',
    });
  });

  it('looks the document up WITH the candidate id, so neither id stands alone', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/cand-1/documents/doc-1`,
    });

    expect(response.statusCode).toBe(200);
    expect(db.candidateDocument.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      id: 'doc-1',
      candidateId: 'cand-1',
      companyId: COMPANY,
    });
  });

  it('excludes a confidential file from the lookup for a plain reader', async () => {
    db.candidateDocument.findFirst.mockResolvedValue(null);

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: READER });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/cand-1/documents/doc-confidential`,
    });

    expect(response.statusCode).toBe(404);
    expect(db.candidateDocument.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      isConfidential: false,
    });
  });

  it('serves a PDF as a download, with nosniff and a private cache', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/cand-1/documents/doc-1`,
    });

    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="muhammad-ali-cv.pdf"',
    );
    expect(response.headers['cache-control']).toContain('private');
    expect(response.rawPayload).toEqual(PDF);
  });

  it('serves an image inline', async () => {
    store.objects.set('candidates/cand-1/doc-png', PNG);
    db.candidateDocument.findFirst.mockResolvedValue({
      id: 'doc-png',
      fileName: 'portfolio.png',
      contentType: 'image/png',
      objectKey: 'candidates/cand-1/doc-png',
    });

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/cand-1/documents/doc-png`,
    });

    expect(response.headers['content-disposition']).toBe('inline; filename="portfolio.png"');
  });

  it('answers 304 to a matching ETag', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const first = await app.inject({ method: 'GET', url: `${PREFIX}/cand-1/documents/doc-1` });
    const etag = first.headers.etag as string;

    const second = await app.inject({
      method: 'GET',
      url: `${PREFIX}/cand-1/documents/doc-1`,
      headers: { 'if-none-match': etag },
    });

    expect(second.statusCode).toBe(304);
  });

  it('404s when the row says there is a file and the store disagrees', async () => {
    store.objects.clear();

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/cand-1/documents/doc-1`,
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('removing one', () => {
  beforeEach(() => {
    db.candidateDocument.findFirst.mockResolvedValue({
      id: 'doc-1',
      fileName: 'muhammad-ali-cv.pdf',
    });
    db.candidateDocument.delete.mockResolvedValue({ id: 'doc-1' });
  });

  it('takes the row and leaves the object, which is housekeeping’s job', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/cand-1/documents/doc-1`,
    });

    expect(response.statusCode).toBe(204);
    expect(db.candidateDocument.delete).toHaveBeenCalledWith({ where: { id: 'doc-1' } });
    expect(objectStore.deleteObject).not.toHaveBeenCalled();
    expect(auditActions(db)).toEqual(['candidate.updated']);
  });

  it('refuses a reader who does not manage candidates', async () => {
    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: READER });
    const response = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/cand-1/documents/doc-1`,
    });

    expect(response.statusCode).toBe(403);
    expect(db.candidateDocument.delete).not.toHaveBeenCalled();
  });

  it('404s on a document that is not on this candidate', async () => {
    db.candidateDocument.findFirst.mockResolvedValue(null);

    const app = await appAs(candidateDocumentRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/cand-1/documents/doc-elsewhere`,
    });

    expect(response.statusCode).toBe(404);
    expect(db.candidateDocument.delete).not.toHaveBeenCalled();
  });
});
