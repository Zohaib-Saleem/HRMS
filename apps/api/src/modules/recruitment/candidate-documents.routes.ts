import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CANDIDATE_DOCUMENT_MAX_BYTES,
  CANDIDATE_DOCUMENT_MAX_PER_CANDIDATE,
  CANDIDATE_DOCUMENT_TOO_LARGE_MESSAGE,
  CANDIDATE_DOCUMENT_TOO_MANY_MESSAGE,
  CASE_ATTACHMENT_CONTENT_TYPES,
  CASE_ATTACHMENT_EXTENSIONS,
  CASE_ATTACHMENT_UNSUPPORTED_MESSAGE,
  PERMISSIONS,
  candidateDocumentUploadQuerySchema,
  safeAttachmentName,
  type CandidateDocumentRecord,
  type CandidateDocumentType,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { getObject, putObject } from '../../core/storage/object-store.js';
import {
  isInlineViewable,
  normaliseAttachmentContentType,
  sniffAttachmentType,
} from '../../core/storage/attachment.js';
import { resolveActor } from './recruitment.service.js';

/**
 * Files on a candidate: the CV, a cover letter, a portfolio, a certificate.
 *
 * Section 14 asks that the EXISTING document infrastructure be used and that no
 * second file storage system be built, and this is that instruction taken
 * literally. Everything here is the case-attachment path with a different key
 * prefix and a different permission:
 *
 *   - `core/storage/object-store` holds the bytes. It is shaped like a bucket
 *     rather than like a filesystem - callers hand it a key and bytes and never
 *     see, build or join a path - so swapping its four functions for S3 would
 *     not change a line in this file.
 *   - `core/storage/attachment` decides what a file IS, from the file's own
 *     leading bytes. The Content-Type header is written by whoever made the
 *     request and a filename says nothing about the bytes behind it, so neither
 *     decides anything.
 *   - the object key is generated here from a UUID, scoped by company and
 *     candidate. The filename is a LABEL: sanitised, stored for display, and
 *     with no bearing on where the file lives, so a hostile name has nowhere to
 *     land.
 *
 * Its own plugin for the mechanical reason the case attachments are: these
 * routes register raw-body content-type parsers, and a parser is scoped to the
 * plugin that adds it. Keeping them here leaves the JSON routes next door as
 * plain JSON routes.
 *
 * The permission split. Reading a document needs `candidate.read`; uploading
 * and deleting need `candidate.manage`. A CONFIDENTIAL document - a reference
 * check, a background report - is excluded by the QUERY for anybody without
 * `candidate.manage`, the way an internal case note is: absent from their
 * lookup rather than fetched and then withheld. An interviewer, who holds
 * neither grant, cannot reach this plugin at all.
 */

/** 413, matching the taxonomy the employee-photo and case routes established. */
class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

/** Slack above the limit before Fastify aborts the request itself. */
const BODY_LIMIT = CANDIDATE_DOCUMENT_MAX_BYTES + 64 * 1024;

const documentParamsSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
});

export const candidateDocumentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  /**
   * The body arrives as raw bytes, not as a multipart form - one file, no
   * fields. The one thing a multipart envelope would add is a filename, which
   * is the part of an upload that must never be trusted anyway.
   */
  for (const type of [
    ...CASE_ATTACHMENT_CONTENT_TYPES,
    'image/jpg',
    'image/pjpeg',
    'application/octet-stream',
  ]) {
    app.addContentTypeParser(
      type,
      { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }

  /**
   * The shelf.
   *
   * Confidential files are excluded by the WHERE clause for a reader without
   * `candidate.manage`, so they are absent rather than hidden - which also
   * means the count a plain reader sees matches the list they get.
   */
  app.get(
    '/:id/documents',
    { preHandler: requirePermission(PERMISSIONS.CANDIDATE_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const actor = await resolveActor(auth);
      const { id } = parseOrThrow(z.object({ id: z.string().min(1) }), request.params);

      const candidate = await prisma.candidate.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true },
      });
      if (!candidate) throw new NotFoundError('Candidate');

      const rows = await prisma.candidateDocument.findMany({
        where: {
          candidateId: candidate.id,
          companyId: auth.companyId,
          ...(actor.canManageCandidates ? {} : { isConfidential: false }),
        },
        include: { uploadedBy: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
      });

      const data: CandidateDocumentRecord[] = rows.map((row) => ({
        id: row.id,
        type: row.type as CandidateDocumentType,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        isConfidential: row.isConfidential,
        uploadedByName: row.uploadedBy
          ? `${row.uploadedBy.firstName} ${row.uploadedBy.lastName}`.trim()
          : null,
        createdAt: row.createdAt.toISOString(),
      }));

      return reply.send({ data });
    },
  );

  /** Uploading one. */
  app.post(
    '/:id/documents',
    {
      bodyLimit: BODY_LIMIT,
      preHandler: requirePermission(PERMISSIONS.CANDIDATE_MANAGE),
    },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(z.object({ id: z.string().min(1) }), request.params);
      const query = parseOrThrow(candidateDocumentUploadQuerySchema, request.query);

      const candidate = await prisma.candidate.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true, fullName: true, reference: true },
      });
      if (!candidate) throw new NotFoundError('Candidate');

      const body: unknown = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new ValidationError({ file: ['Choose a file to upload.'] });
      }
      if (body.length > CANDIDATE_DOCUMENT_MAX_BYTES) {
        throw new PayloadTooLargeError(CANDIDATE_DOCUMENT_TOO_LARGE_MESSAGE);
      }

      /*
       * What the file actually is, read from its own leading bytes. A declared
       * Content-Type that disagrees is not a reason to guess in the client's
       * favour: a PNG announced as a PDF is stored and served as a PNG, and
       * anything whose bytes match nothing we accept is refused outright.
       */
      const declared = normaliseAttachmentContentType(request.headers['content-type']);
      const contentType = sniffAttachmentType(body, request.headers['content-type']);
      if (!contentType) {
        throw new ValidationError({ file: [CASE_ATTACHMENT_UNSUPPORTED_MESSAGE] });
      }
      if (declared !== null && declared !== contentType) {
        request.log.warn(
          { candidateId: candidate.id, declared, sniffed: contentType },
          'candidate document does not match its declared type',
        );
      }

      // Unbounded uploads are a way to fill a disk 10 MB at a time from an
      // ordinary account, which is why the per-candidate ceiling exists.
      const existing = await prisma.candidateDocument.count({
        where: { candidateId: candidate.id },
      });
      if (existing >= CANDIDATE_DOCUMENT_MAX_PER_CANDIDATE) {
        throw new ConflictError(CANDIDATE_DOCUMENT_TOO_MANY_MESSAGE);
      }

      const fileName = safeAttachmentName(
        query.filename ?? '',
        `document.${CASE_ATTACHMENT_EXTENSIONS[contentType]}`,
      );

      /*
       * Generated here, from a UUID, owing nothing to anything the client sent.
       * Scoped by company and candidate so an upload cannot name, reach or
       * overwrite a file on another candidate even if the generator collided.
       */
      const objectKey = `candidate-documents/${auth.companyId}/${candidate.id}/${randomUUID()}.${CASE_ATTACHMENT_EXTENSIONS[contentType]}`;

      // The file first, the row second. A written file nobody references is
      // wasted disk; a referenced file that was never written is a broken link.
      await putObject(objectKey, body);

      const created = await prisma.candidateDocument.create({
        data: {
          companyId: auth.companyId,
          candidateId: candidate.id,
          type: query.type ?? 'OTHER',
          uploadedByUserId: auth.userId,
          fileName,
          contentType,
          sizeBytes: body.length,
          objectKey,
          isConfidential: query.confidential === 'true',
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'candidate.updated',
        entityType: 'Candidate',
        entityId: candidate.id,
        summary: `Uploaded ${fileName} for ${candidate.fullName} (${candidate.reference})`,
        // Facts about the file, never the file, and never the object key: the
        // audit log is read by people, and a storage key is not a fact about
        // the candidate.
        after: {
          documentId: created.id,
          fileName,
          contentType,
          bytes: body.length,
          type: created.type,
          confidential: created.isConfidential,
        },
        request,
      });

      const record: CandidateDocumentRecord = {
        id: created.id,
        type: created.type as CandidateDocumentType,
        fileName: created.fileName,
        contentType: created.contentType,
        sizeBytes: created.sizeBytes,
        isConfidential: created.isConfidential,
        uploadedByName: null,
        createdAt: created.createdAt.toISOString(),
      };

      return reply.code(201).send({ data: record });
    },
  );

  /**
   * Downloading one.
   *
   * Both ids are in the path and BOTH are checked: the candidate is proved to
   * be in this company, and the document is then looked up WITH that candidate
   * id in the WHERE clause. Neither id is load-bearing on its own - a document
   * id from another candidate fails because it is not on this one, and pairing
   * a foreign document id with a valid candidate id fails for the same reason.
   *
   * Confidential files are excluded by the query for a reader without
   * `candidate.manage`, so holding the id of one buys nothing.
   */
  app.get(
    '/:id/documents/:documentId',
    { preHandler: requirePermission(PERMISSIONS.CANDIDATE_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const actor = await resolveActor(auth);
      const { id, documentId } = parseOrThrow(documentParamsSchema, request.params);

      const candidate = await prisma.candidate.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true },
      });
      if (!candidate) throw new NotFoundError('Candidate');

      const document = await prisma.candidateDocument.findFirst({
        where: {
          id: documentId,
          candidateId: candidate.id,
          companyId: auth.companyId,
          ...(actor.canManageCandidates ? {} : { isConfidential: false }),
        },
        select: { id: true, fileName: true, contentType: true, objectKey: true },
      });
      if (!document) throw new NotFoundError('Document');

      const bytes = await getObject(document.objectKey);
      if (!bytes) {
        // The row says there is a file and the store disagrees. Reported as
        // missing - which is what the caller sees either way - and logged
        // loudly so the inconsistency is not silent.
        request.log.error(
          { candidateId: candidate.id, documentId: document.id },
          'candidate document missing from the file store',
        );
        throw new NotFoundError('Document');
      }

      const etag = `"${document.id}"`;
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();

      /*
       * The name in the header is the sanitised one from the database, quoted
       * and with quotes and backslashes escaped. It has already had control
       * characters stripped on the way in, so nothing here could break the
       * header apart - but it is escaped anyway, because a header built by
       * concatenation is worth being twice as careful about.
       */
      const headerName = document.fileName.replace(/["\\]/g, '_');
      const disposition = isInlineViewable(document.contentType) ? 'inline' : 'attachment';

      return reply
        .header('Content-Type', document.contentType)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `${disposition}; filename="${headerName}"`)
        // A document never changes - a replacement is a new row with a new id -
        // so the id is a perfect ETag. Private either way: this is a file
        // behind a permission check and must never enter a shared cache.
        .header('Cache-Control', 'private, max-age=3600, immutable')
        .header('ETag', etag)
        .send(bytes);
    },
  );

  /**
   * Removing one.
   *
   * The row goes and the object stays. That is deliberate: an orphaned object
   * costs disk, and a deleted object whose row somehow survives - or whose
   * deletion raced a download - is a 500 in front of a user. Reaping orphans is
   * a housekeeping job, not something to do inside a request.
   */
  app.delete(
    '/:id/documents/:documentId',
    { preHandler: requirePermission(PERMISSIONS.CANDIDATE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id, documentId } = parseOrThrow(documentParamsSchema, request.params);

      const candidate = await prisma.candidate.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true, fullName: true, reference: true },
      });
      if (!candidate) throw new NotFoundError('Candidate');

      const document = await prisma.candidateDocument.findFirst({
        where: { id: documentId, candidateId: candidate.id, companyId: auth.companyId },
        select: { id: true, fileName: true },
      });
      if (!document) throw new NotFoundError('Document');

      await prisma.candidateDocument.delete({ where: { id: document.id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'candidate.updated',
        entityType: 'Candidate',
        entityId: candidate.id,
        summary: `Removed ${document.fileName} from ${candidate.fullName} (${candidate.reference})`,
        before: { documentId: document.id, fileName: document.fileName },
        request,
      });

      return reply.code(204).send();
    },
  );
};
