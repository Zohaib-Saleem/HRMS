import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CASE_ATTACHMENT_CONTENT_TYPES,
  CASE_ATTACHMENT_EXTENSIONS,
  CASE_ATTACHMENT_MAX_BYTES,
  CASE_ATTACHMENT_MAX_PER_CASE,
  CASE_ATTACHMENT_TOO_LARGE_MESSAGE,
  CASE_ATTACHMENT_TOO_MANY_MESSAGE,
  CASE_ATTACHMENT_UNSUPPORTED_MESSAGE,
  PERMISSIONS,
  canRequesterReply,
  safeAttachmentName,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAnyPermission, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { getObject, putObject } from '../../core/storage/object-store.js';
import {
  isInlineViewable,
  normaliseAttachmentContentType,
  sniffAttachmentType,
} from '../../core/storage/attachment.js';
import { ownCaseOrThrow, requireRequester, resolveRequester } from './cases.service.js';

/**
 * Files on a case.
 *
 * Its own plugin on the same `/cases` prefix, for the same reason the employee
 * photo routes are separate from the employee routes: these need raw-body
 * content-type parsers registered for half a dozen media types, and a parser is
 * scoped to the plugin that adds it. Keeping them here means the JSON routes
 * next door stay JSON routes.
 *
 * The storage is the one the HRMS already has. `core/storage/object-store`
 * holds employee photos today; it is shaped like a bucket rather than like a
 * filesystem - callers hand it a key and bytes and never see, build or join a
 * path - so a case attachment is the same two calls with a different key
 * prefix. Nothing new was invented to hold these files, and swapping the four
 * functions in that module for S3 would still not change a line here.
 *
 * Five rules, all enforced on the server and none of them only in the browser:
 *
 *   - the case must be the CALLER'S OWN. Both endpoints reach it through
 *     `ownCaseOrThrow`, which puts the requester's employee id in the WHERE
 *     clause, so an attachment on somebody else's case is a 404 both to upload
 *     to and to download from - even with a valid attachment id.
 *   - the bytes must actually be one of the formats we accept, established from
 *     the file's own header rather than from the Content-Type it arrived with.
 *   - the file must be 10 MB or less, and the case must be under its total.
 *   - the object key is generated here from a UUID, scoped by company and case.
 *     The filename is a LABEL: it is sanitised, stored for display, and has no
 *     bearing on where the file lives, so a hostile name has nowhere to land.
 *   - the key never leaves the server. A download is an authenticated endpoint
 *     that re-checks the case, so a file is exactly as private as the case it
 *     belongs to.
 */

/** 413, matching the employee-photo route's addition to the taxonomy. */
class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

/**
 * Slack above the limit before Fastify aborts the request itself.
 *
 * The check below is the one that produces a readable message and it can only
 * run on a body that was fully read; Fastify's own limit is the backstop for a
 * body far larger than the rule, where reading it all just to refuse it would
 * be the wrong trade.
 */
const BODY_LIMIT = CASE_ATTACHMENT_MAX_BYTES + 64 * 1024;

/**
 * The upload's query string.
 *
 * `filename` is the only thing a client tells us about the file that we keep,
 * and it is kept as a label. `messageId`, when present, hangs the file off a
 * reply rather than off the case - and is proved to belong to this case before
 * anything is written.
 */
const uploadQuerySchema = z.object({
  filename: z.string().trim().max(400).optional(),
  messageId: z.string().trim().max(64).optional(),
});

const attachmentParamsSchema = z.object({
  id: z.string().min(1),
  attachmentId: z.string().min(1),
});

export const caseAttachmentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  /**
   * The body arrives as raw bytes, not as a multipart form.
   *
   * One file, no fields - and the one thing a multipart envelope would add is a
   * filename, which is the part of an upload that must never be trusted anyway.
   * Not taking one that way means there is no multipart parser to depend on and
   * nothing to collide; the name comes in on the query string, is sanitised,
   * and is used for display only.
   *
   * `text/*` is parsed as a buffer like everything else rather than as a
   * string, because the sniffer needs the bytes exactly as they arrived to
   * prove they are valid UTF-8.
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
   * Attaching a file.
   *
   * Reachable by anybody who could have produced the thing it is attached to -
   * the create form (`case.create`) or a reply (`case.reply.own`) - because
   * from the caller's side attaching is part of one of those two acts rather
   * than a third one. The case still has to be theirs, and it still has to be
   * open to replies: a closed case takes no new files for the same reason it
   * takes no new messages.
   */
  app.post(
    '/:id/attachments',
    {
      bodyLimit: BODY_LIMIT,
      preHandler: requireAnyPermission(PERMISSIONS.CASE_CREATE, PERMISSIONS.CASE_REPLY_OWN),
    },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(z.object({ id: z.string().min(1) }), request.params);
      const query = parseOrThrow(uploadQuerySchema, request.query);
      const requester = requireRequester(await resolveRequester(auth));

      const row = await ownCaseOrThrow(requester, id);

      if (!canRequesterReply(row.status)) {
        throw new ConflictError('This case is closed, so nothing more can be attached to it.');
      }

      const body: unknown = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new ValidationError({ file: ['Choose a file to attach.'] });
      }

      if (body.length > CASE_ATTACHMENT_MAX_BYTES) {
        throw new PayloadTooLargeError(CASE_ATTACHMENT_TOO_LARGE_MESSAGE);
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
          { caseId: row.id, declared, sniffed: contentType },
          'case attachment does not match its declared type',
        );
      }

      /*
       * The per-case ceiling, counted across replies as well as the case
       * itself. Unbounded attachments are a way to fill a disk 10 MB at a time
       * from an ordinary employee account.
       */
      const existing = await prisma.caseAttachment.count({ where: { caseId: row.id } });
      if (existing >= CASE_ATTACHMENT_MAX_PER_CASE) {
        throw new ConflictError(CASE_ATTACHMENT_TOO_MANY_MESSAGE);
      }

      /*
       * A reply to hang it off, proved to belong to THIS case. Without the
       * `caseId` in this lookup, a message id from somebody else's case would
       * attach a file across the boundary - and the file would then be readable
       * by the other case's owner.
       */
      let messageId: string | null = null;
      if (query.messageId) {
        const message = await prisma.caseMessage.findFirst({
          where: {
            id: query.messageId,
            caseId: row.id,
            companyId: auth.companyId,
            // An employee can only ever attach to a message they can see.
            isInternal: false,
          },
          select: { id: true },
        });
        if (!message) throw new NotFoundError('Case reply');
        messageId = message.id;
      }

      const fileName = safeAttachmentName(
        query.filename ?? '',
        `attachment.${CASE_ATTACHMENT_EXTENSIONS[contentType]}`,
      );

      /*
       * Generated here, from a UUID, and owing nothing to anything the client
       * sent. Scoped by company and case so an upload cannot name, reach or
       * overwrite a file on another case even if the generator somehow
       * collided.
       */
      const objectKey = `case-attachments/${auth.companyId}/${row.id}/${randomUUID()}.${CASE_ATTACHMENT_EXTENSIONS[contentType]}`;

      // The file first, the row second. A written file nobody references is
      // wasted disk; a referenced file that was never written is a broken link.
      await putObject(objectKey, body);

      const created = await prisma.caseAttachment.create({
        data: {
          companyId: auth.companyId,
          caseId: row.id,
          messageId,
          uploadedByUserId: auth.userId,
          fileName,
          contentType,
          sizeBytes: body.length,
          objectKey,
          // An employee's upload is never a staff-only file.
          isInternal: false,
        },
        select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'case.attachment.add',
        entityType: 'Case',
        entityId: row.id,
        summary: `Attached ${fileName} to case ${row.caseNumber}`,
        // Facts about the file, never the file. The object key is not written
        // here either: the audit log is read by people, and a storage key is
        // not a fact about the case.
        after: {
          attachmentId: created.id,
          fileName,
          contentType,
          bytes: body.length,
          messageId,
        },
        request,
      });

      return reply.status(201).send({
        data: {
          id: created.id,
          messageId,
          fileName: created.fileName,
          contentType: created.contentType,
          sizeBytes: created.sizeBytes,
          uploadedByName: null,
          createdAt: created.createdAt.toISOString(),
        },
      });
    },
  );

  /**
   * Downloading a file.
   *
   * The case id is in the path as well as the attachment id, and both are
   * checked: the case is fetched through `ownCaseOrThrow` first, and the
   * attachment is then looked up WITH that case id in the WHERE clause. So
   * neither id is load-bearing on its own - guessing an attachment id from
   * another case fails because the case is not the caller's, and pairing a
   * foreign attachment id with one's own case id fails because the attachment
   * is not on it.
   *
   * Staff-only files are excluded by the query, so an employee cannot reach the
   * file attached to an internal note even with its id.
   *
   * Everything is served `private` and `nosniff`, with the type sniffed at
   * upload rather than anything a client once claimed. Images may render
   * inline; a PDF or a text file is sent as a download, because a PDF viewer is
   * a program and a text file rendered inline is a page on the API's own
   * origin - neither is worth it when the alternative costs one click.
   */
  app.get(
    '/:id/attachments/:attachmentId',
    { preHandler: requirePermission(PERMISSIONS.CASE_READ_OWN) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id, attachmentId } = parseOrThrow(attachmentParamsSchema, request.params);
      const requester = requireRequester(await resolveRequester(auth));

      const row = await ownCaseOrThrow(requester, id);

      const attachment = await prisma.caseAttachment.findFirst({
        where: {
          id: attachmentId,
          caseId: row.id,
          companyId: auth.companyId,
          isInternal: false,
        },
        select: { id: true, fileName: true, contentType: true, objectKey: true, createdAt: true },
      });
      if (!attachment) throw new NotFoundError('Attachment');

      const bytes = await getObject(attachment.objectKey);
      // The row says there is a file and the store disagrees. Reported as
      // missing, which is what the caller sees either way, and logged loudly so
      // the inconsistency is not silent.
      if (!bytes) {
        request.log.error(
          { caseId: row.id, attachmentId: attachment.id },
          'case attachment missing from the file store',
        );
        throw new NotFoundError('Attachment');
      }

      const etag = `"${attachment.id}"`;
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();

      /*
       * The name in the header is the sanitised one from the database, quoted
       * and with quotes and backslashes escaped. It has already had control
       * characters stripped on the way in, so there is nothing here that could
       * break the header apart - but it is escaped anyway, because a header
       * built by concatenation is worth being twice as careful about.
       */
      const headerName = attachment.fileName.replace(/["\\]/g, '_');
      const disposition = isInlineViewable(attachment.contentType) ? 'inline' : 'attachment';

      return reply
        .header('Content-Type', attachment.contentType)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `${disposition}; filename="${headerName}"`)
        // An attachment never changes - a replacement is a new row with a new
        // id - so the id is a perfect ETag and the content is immutable. Private
        // either way: this is a file behind a permission check and must never
        // enter a shared cache.
        .header('Cache-Control', 'private, max-age=3600, immutable')
        .header('ETag', etag)
        .send(bytes);
    },
  );
};
