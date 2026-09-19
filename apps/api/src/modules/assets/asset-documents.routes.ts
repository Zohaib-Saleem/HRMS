import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ASSET_DOCUMENT_MAX_BYTES,
  ASSET_DOCUMENT_MAX_PER_ASSET,
  ASSET_DOCUMENT_TOO_LARGE_MESSAGE,
  ASSET_DOCUMENT_TOO_MANY_MESSAGE,
  ASSET_DOCUMENT_TYPE_LABELS,
  CASE_ATTACHMENT_CONTENT_TYPES,
  CASE_ATTACHMENT_EXTENSIONS,
  CASE_ATTACHMENT_UNSUPPORTED_MESSAGE,
  PERMISSIONS,
  assetDocumentUploadQuerySchema,
  safeAttachmentName,
  type AssetDocumentRecord,
  type AssetDocumentType,
  type CaseAttachmentContentType,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { deleteObject, getObject, putObject } from '../../core/storage/object-store.js';
import {
  isInlineViewable,
  normaliseAttachmentContentType,
  sniffAttachmentType,
} from '../../core/storage/attachment.js';

/**
 * Files about an asset: the invoice, the warranty, a repair receipt, the signed
 * handover.
 *
 * Section 13 asks that the EXISTING document infrastructure be used and that no
 * second storage system be built, and this is that instruction taken literally.
 * Everything here is the candidate-document path - which is itself the
 * case-attachment path - with a different key prefix and a different
 * permission:
 *
 *   - `core/storage/object-store` holds the bytes. It is shaped like a bucket
 *     rather than like a filesystem, so swapping its four functions for S3
 *     would not change a line in this file.
 *   - `core/storage/attachment` decides what a file IS, from the file's own
 *     leading bytes. The Content-Type header is written by whoever made the
 *     request and a filename says nothing about the bytes behind it, so neither
 *     decides anything.
 *   - the accepted formats, the extension map and the 10 MB ceiling are the
 *     SAME constants the cases and recruitment modules use. Not a copy - the
 *     same exported values, so a format added there is added here.
 *
 * Its own plugin for the mechanical reason the case attachments and candidate
 * documents are: these routes register raw-body content-type parsers, and a
 * parser is scoped to the plugin that adds it. Keeping them here leaves the
 * JSON routes next door as plain JSON routes.
 *
 * The permission split. Reading needs `asset.read.all` - the same grant the
 * register itself needs, because an invoice is a fact about company property
 * and not about the person currently holding it. Uploading and deleting need
 * `asset.update`.
 */

/** 413, matching the taxonomy the case and candidate routes established. */
class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

/** Slack above the limit before Fastify aborts the request itself. */
const BODY_LIMIT = ASSET_DOCUMENT_MAX_BYTES + 64 * 1024;

const documentParamsSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
});

function toDocumentRecord(row: {
  id: string;
  type: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  repairId: string | null;
  createdAt: Date;
  uploadedBy?: { firstName: string; lastName: string } | null;
}): AssetDocumentRecord {
  return {
    id: row.id,
    type: row.type as AssetDocumentType,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    repairId: row.repairId,
    uploadedByName: row.uploadedBy
      ? `${row.uploadedBy.firstName} ${row.uploadedBy.lastName}`.trim()
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const assetDocumentRoutes: FastifyPluginAsync = async (app) => {
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

  /** Proves the asset is this company's, and hands back what audit needs. */
  async function assetOr404(companyId: string, id: string) {
    const asset = await prisma.asset.findFirst({
      where: { id, companyId },
      select: { id: true, assetTag: true, name: true },
    });
    if (!asset) throw new NotFoundError('Asset');
    return asset;
  }

  app.get(
    '/:id/documents',
    { preHandler: requirePermission(PERMISSIONS.ASSET_READ_ALL) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(z.object({ id: z.string().min(1) }), request.params);
      const asset = await assetOr404(auth.companyId, id);

      const rows = await prisma.assetDocument.findMany({
        where: { assetId: asset.id, companyId: auth.companyId },
        include: { uploadedBy: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
      });

      return reply.send({ data: rows.map(toDocumentRecord) });
    },
  );

  app.post(
    '/:id/documents',
    { bodyLimit: BODY_LIMIT, preHandler: requirePermission(PERMISSIONS.ASSET_UPDATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(z.object({ id: z.string().min(1) }), request.params);
      const query = parseOrThrow(assetDocumentUploadQuerySchema, request.query);
      const asset = await assetOr404(auth.companyId, id);

      const body: unknown = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new ValidationError({ file: ['Choose a file to upload.'] });
      }
      if (body.length > ASSET_DOCUMENT_MAX_BYTES) {
        throw new PayloadTooLargeError(ASSET_DOCUMENT_TOO_LARGE_MESSAGE);
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
          { assetId: asset.id, declared, sniffed: contentType },
          'asset document does not match its declared type',
        );
      }

      // Unbounded uploads are a way to fill a disk 10 MB at a time from an
      // ordinary account, which is why the per-asset ceiling exists.
      const existing = await prisma.assetDocument.count({ where: { assetId: asset.id } });
      if (existing >= ASSET_DOCUMENT_MAX_PER_ASSET) {
        throw new ConflictError(ASSET_DOCUMENT_TOO_MANY_MESSAGE);
      }

      // A repair receipt hangs off the repair it belongs to. Proved to be this
      // asset's, so the link cannot be used to point at another asset's repair.
      let repairId: string | null = null;
      if (query.repairId) {
        const repair = await prisma.assetRepair.findFirst({
          where: { id: query.repairId, assetId: asset.id, companyId: auth.companyId },
          select: { id: true },
        });
        if (!repair) throw new ValidationError({ repairId: ['That repair does not exist.'] });
        repairId = repair.id;
      }

      const extension = CASE_ATTACHMENT_EXTENSIONS[contentType as CaseAttachmentContentType];
      const fileName = safeAttachmentName(query.filename ?? '', `document.${extension}`);

      /*
       * Generated here, from a UUID, owing nothing to anything the client sent.
       * Scoped by company and asset so an upload cannot name, reach or
       * overwrite a file on another asset even if the generator collided.
       */
      const objectKey = `asset-documents/${auth.companyId}/${asset.id}/${randomUUID()}.${extension}`;

      // The file first, the row second. A written file nobody references is
      // wasted disk; a referenced file that was never written is a broken link.
      await putObject(objectKey, body);

      const created = await prisma.assetDocument.create({
        data: {
          companyId: auth.companyId,
          assetId: asset.id,
          repairId,
          type: query.type ?? 'OTHER',
          uploadedByUserId: auth.userId,
          fileName,
          contentType,
          sizeBytes: body.length,
          objectKey,
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.document.added',
        entityType: 'Asset',
        entityId: asset.id,
        summary: `Attached ${fileName} (${ASSET_DOCUMENT_TYPE_LABELS[created.type as AssetDocumentType]}) to ${asset.assetTag} - ${asset.name}`,
        // Facts about the file, never the file, and never the object key: the
        // audit log is read by people, and a storage key is not a fact about
        // the asset.
        after: {
          documentId: created.id,
          fileName,
          contentType,
          bytes: body.length,
          type: created.type,
        },
        request,
      });

      return reply.code(201).send({ data: toDocumentRecord(created) });
    },
  );

  /**
   * Downloading one.
   *
   * Both ids are in the path and BOTH are checked: the asset is proved to be in
   * this company, and the document is then looked up WITH that asset id in the
   * WHERE clause. Neither id is load-bearing on its own - a document id from
   * another asset fails because it is not on this one, and pairing a foreign
   * document id with a valid asset id fails for the same reason.
   */
  app.get(
    '/:id/documents/:documentId',
    { preHandler: requirePermission(PERMISSIONS.ASSET_READ_ALL) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id, documentId } = parseOrThrow(documentParamsSchema, request.params);
      const asset = await assetOr404(auth.companyId, id);

      const document = await prisma.assetDocument.findFirst({
        where: { id: documentId, assetId: asset.id, companyId: auth.companyId },
        select: { id: true, fileName: true, contentType: true, objectKey: true },
      });
      if (!document) throw new NotFoundError('Document');

      const bytes = await getObject(document.objectKey);
      if (!bytes) {
        // The row says there is a file and the store disagrees. Reported as
        // missing - which is what the caller sees either way - and logged
        // loudly so the inconsistency is not silent.
        request.log.error(
          { assetId: asset.id, documentId: document.id },
          'asset document missing from the file store',
        );
        throw new NotFoundError('Document');
      }

      const etag = `"${document.id}"`;
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();

      return reply
        .header('Content-Type', document.contentType)
        .header('Content-Length', String(bytes.length))
        .header('Cache-Control', 'private, max-age=300')
        .header('ETag', etag)
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `${isInlineViewable(document.contentType) ? 'inline' : 'attachment'}; filename="${document.fileName.replace(/"/g, '')}"`,
        )
        .send(bytes);
    },
  );

  /**
   * Removing one.
   *
   * The row first, the file second. A row without its bytes is a broken link a
   * person can see and report; bytes without a row are invisible and stay on
   * the disk forever. A failed delete of the object is logged and not raised -
   * the document is gone as far as anybody is concerned.
   */
  app.delete(
    '/:id/documents/:documentId',
    { preHandler: requirePermission(PERMISSIONS.ASSET_UPDATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id, documentId } = parseOrThrow(documentParamsSchema, request.params);
      const asset = await assetOr404(auth.companyId, id);

      const document = await prisma.assetDocument.findFirst({
        where: { id: documentId, assetId: asset.id, companyId: auth.companyId },
      });
      if (!document) throw new NotFoundError('Document');

      await prisma.assetDocument.delete({ where: { id: document.id } });

      try {
        await deleteObject(document.objectKey);
      } catch (error) {
        request.log.error(
          { err: error, assetId: asset.id, documentId: document.id },
          'asset document row removed but its file could not be deleted',
        );
      }

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'asset.document.removed',
        entityType: 'Asset',
        entityId: asset.id,
        summary: `Removed ${document.fileName} from ${asset.assetTag} - ${asset.name}`,
        before: { documentId: document.id, fileName: document.fileName, type: document.type },
        request,
      });

      return reply.code(204).send();
    },
  );
};
