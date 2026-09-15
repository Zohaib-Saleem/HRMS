import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  EMPLOYEE_PHOTO_CONTENT_TYPES,
  EMPLOYEE_PHOTO_EXTENSIONS,
  EMPLOYEE_PHOTO_MAX_BYTES,
  EMPLOYEE_PHOTO_TOO_LARGE_MESSAGE,
  EMPLOYEE_PHOTO_UNSUPPORTED_MESSAGE,
  PERMISSIONS,
  employeePhotoUrl,
  idParamSchema,
  normaliseEmployeePhotoContentType,
  type EmployeePhotoResult,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext } from '../../auth/guards.js';
import { assertEmployeeInScope } from '../../auth/scope.js';
import type { AuthContext } from '../../auth/session.js';
import { sniffImageType } from '../../core/storage/image.js';
import { deleteObject, getObject, putObject } from '../../core/storage/object-store.js';

/**
 * The employee profile photo.
 *
 * Its own plugin rather than three more routes in `employees.routes.ts`, for
 * one reason that matters: that file gates every route behind `employee.read`,
 * and an ordinary employee does not hold it. They are nevertheless allowed to
 * change the photo on their own record - the same way they already change their
 * own name and password - so these routes carry their own gate.
 *
 * Who may do what:
 *
 *   read   `employee.read` within the caller's data scope, OR the record is
 *          the caller's own. This is what makes an avatar render in a list -
 *          anyone who can see the person can see their face.
 *   write  `employee.manage` within the caller's data scope, OR the record is
 *          the caller's own. Super Admin and HR Admin hold `employee.manage`
 *          with an ALL scope and so reach anybody; a manager holds `read` and
 *          not `manage`, so they can see a report's photo and cannot touch it;
 *          an employee holds neither and reaches exactly one record - theirs.
 *
 * "Their own" is decided from the session's user id against the employee row's
 * `userId`, never from anything in the request. There is no payload an employee
 * could alter to become somebody else.
 *
 * The file itself never touches the database. `photoObjectKey` names an object
 * in the file store and the bytes live there; nothing here builds, accepts or
 * returns a filesystem path.
 */

/** 413, which the shared error taxonomy had no cause to carry before this. */
class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

/**
 * Slack above the 5 MB limit before Fastify aborts the request itself.
 *
 * The check below is the one that produces a readable message, and it can only
 * run on a body that was fully read. Fastify's own limit is the backstop for a
 * body far larger than the rule, where reading it all just to refuse it would
 * be the wrong trade.
 */
const BODY_LIMIT = EMPLOYEE_PHOTO_MAX_BYTES + 64 * 1024;

/** The columns a photo request needs, and nothing else from the record. */
const PHOTO_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  employeeNumber: true,
  userId: true,
  photoUrl: true,
  photoObjectKey: true,
  photoContentType: true,
  photoUpdatedAt: true,
} as const;

type PhotoRow = {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber: string;
  userId: string | null;
  photoUrl: string | null;
  photoObjectKey: string | null;
  photoContentType: string | null;
  photoUpdatedAt: Date | null;
};

/**
 * Finds the employee and decides whether this caller may reach their photo.
 *
 * The lookup is company-scoped before anything else, so an id belonging to
 * another company is simply not found - a tenant boundary is not a permission
 * question and is not left to one.
 */
async function authorisePhoto(
  request: FastifyRequest,
  employeeId: string,
  mode: 'read' | 'write',
): Promise<{ auth: AuthContext; employee: PhotoRow }> {
  const auth = requireAuthContext(request);

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId: auth.companyId },
    select: PHOTO_SELECT,
  });
  if (!employee) throw new NotFoundError('Employee');

  // Their own record. Decided from the session, never from the request.
  if (employee.userId !== null && employee.userId === auth.userId) return { auth, employee };

  const required = mode === 'write' ? PERMISSIONS.EMPLOYEE_MANAGE : PERMISSIONS.EMPLOYEE_READ;
  if (!auth.permissions.has(required)) {
    request.log.warn(
      { userId: auth.userId, employeeId, mode, missing: required },
      'employee photo permission denied',
    );
    throw new ForbiddenError('You do not have permission to do that.');
  }

  // Holding the permission is not the same as reaching this person: a manager
  // with REPORTS scope stops at their own line.
  await assertEmployeeInScope(auth, employeeId);

  return { auth, employee };
}

const displayName = (employee: PhotoRow) => `${employee.firstName} ${employee.lastName}`.trim();

/** What the write endpoints answer with: the avatar, after the change. */
function photoResult(employee: {
  id: string;
  photoUrl: string | null;
  photoObjectKey: string | null;
  photoUpdatedAt: Date | null;
}): EmployeePhotoResult {
  const updatedAt = employee.photoUpdatedAt?.toISOString() ?? null;
  return {
    photoUrl: employee.photoObjectKey
      ? employeePhotoUrl(employee.id, updatedAt)
      : employee.photoUrl,
    hasPhoto: employee.photoObjectKey !== null,
    updatedAt,
  };
}

export const employeePhotoRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Signed in is the only blanket requirement; each route decides the rest.
   *
   * Deliberately NOT `requirePermission(EMPLOYEE_READ)` like the sibling
   * employee plugin: that would lock an employee out of their own photo.
   */
  app.addHook('preHandler', requireAuth);

  /**
   * The body arrives as raw image bytes, not as a multipart form.
   *
   * One file, no fields, no filename - and a filename is the one thing a file
   * upload carries that must never be trusted anyway. Not taking one means
   * there is nothing to sanitise, nothing to collide, and no dependency on a
   * multipart parser. The object key is generated server-side regardless of
   * what the client sends, so a hostile name has nowhere to land.
   */
  for (const type of ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp']) {
    app.addContentTypeParser(
      type,
      { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }

  /**
   * The photo itself.
   *
   * Served through the API rather than from a static directory so it is behind
   * the same session and the same scope check as the record it belongs to -
   * an employee's face is personal data, and a public URL would make it
   * guessable by anyone who learned the id.
   *
   * `Cache-Control: private` keeps it out of shared caches; the ETag is the
   * photo's own timestamp, so a browser that already has the current one gets a
   * 304 and nothing is re-sent.
   */
  app.get(
    '/:id/photo',
    {
      /**
       * A roomier allowance than the global one.
       *
       * A page of fifty people is fifty image requests on top of the API calls
       * that drew it, and the default 300-a-minute budget is sized for the
       * latter. Serving an avatar is a file read, not a query, so it does not
       * deserve to be what exhausts somebody's quota while they page through
       * the directory. Ignored outside the application, where the rate limiter
       * is not registered at all.
       */
      config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = parseOrThrow(idParamSchema, request.params);
      const { employee } = await authorisePhoto(request, id, 'read');

      if (!employee.photoObjectKey) throw new NotFoundError('Profile photo');

      const bytes = await getObject(employee.photoObjectKey);
      // The row says there is a photo and the store disagrees. Reported as a
      // missing photo, which is what the caller sees either way, and logged so
      // the inconsistency is not silent.
      if (!bytes) {
        request.log.error({ employeeId: id }, 'employee photo missing from the file store');
        throw new NotFoundError('Profile photo');
      }

      const etag = `"${employee.photoUpdatedAt?.getTime() ?? 0}"`;
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();

      /**
       * How long the browser may keep it.
       *
       * A URL carrying `?v=<timestamp>` is content-addressed: replacing the photo
       * changes the timestamp, so that URL can never answer with different bytes
       * and the browser need not ask again. A bare URL gets no such promise and is
       * revalidated every time.
       *
       * `private` either way. This is somebody's face behind a permission check,
       * so it must never enter a shared cache - only the browser of the person who
       * was already allowed to see it.
       */
      const versioned = typeof (request.query as { v?: unknown }).v === 'string';
      const cacheControl = versioned
        ? 'private, max-age=86400, immutable'
        : 'private, max-age=0, must-revalidate';

      return (
        reply
          // The sniffed type recorded at upload, never a client's claim.
          .header('Content-Type', employee.photoContentType ?? 'application/octet-stream')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Disposition', 'inline')
          .header('Cache-Control', cacheControl)
          .header('ETag', etag)
          .send(bytes)
      );
    },
  );

  /**
   * Upload, or replace.
   *
   * One endpoint for both, because from the caller's side they are one action -
   * "this is the photo now". The audit trail still tells them apart.
   *
   * Every rule is enforced here and not only in the browser:
   *   - the bytes must begin like a JPEG, PNG or WebP, whatever the request
   *     claimed they were;
   *   - the file must be 5 MB or less;
   *   - the key is generated here, scoped by company and employee, and ends in
   *     a fresh UUID - so no upload can name, reach or overwrite another
   *     employee's photo, and replacing one never reuses its key.
   */
  app.post('/:id/photo', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const { id } = parseOrThrow(idParamSchema, request.params);
    const { auth, employee } = await authorisePhoto(request, id, 'write');

    const body: unknown = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ValidationError({ photo: ['Choose an image to upload.'] });
    }

    if (body.length > EMPLOYEE_PHOTO_MAX_BYTES) {
      throw new PayloadTooLargeError(EMPLOYEE_PHOTO_TOO_LARGE_MESSAGE);
    }

    /**
     * What the file actually is.
     *
     * Read from the file's own header. A declared Content-Type that disagrees
     * is not a reason to guess in the client's favour: a PNG announced as a
     * JPEG is stored as a PNG and served as one, and anything whose header
     * matches none of the three is refused outright.
     */
    const contentType = sniffImageType(body);
    if (!contentType)
      throw new ValidationError({
        photo: [EMPLOYEE_PHOTO_UNSUPPORTED_MESSAGE],
      });

    const declared = normaliseEmployeePhotoContentType(request.headers['content-type']);
    if (declared !== null && declared !== contentType) {
      request.log.warn(
        { employeeId: id, declared, sniffed: contentType },
        'uploaded photo does not match its declared type',
      );
    }

    const previousKey = employee.photoObjectKey;
    const key = `employee-photos/${auth.companyId}/${employee.id}/${randomUUID()}.${EMPLOYEE_PHOTO_EXTENSIONS[contentType]}`;

    // The file first, the row second. A written file nobody references is
    // wasted disk; a referenced file that was never written is a broken avatar.
    await putObject(key, body);

    const updated = await prisma.employee.update({
      where: { id: employee.id },
      data: {
        photoObjectKey: key,
        photoContentType: contentType,
        photoUpdatedAt: new Date(),
      },
      select: {
        id: true,
        photoUrl: true,
        photoObjectKey: true,
        photoUpdatedAt: true,
      },
    });

    // The old file, now that nothing points at it. Failing to delete it costs
    // disk and nothing else, so it must not fail the request.
    if (previousKey && previousKey !== key) {
      await deleteObject(previousKey).catch((error: unknown) => {
        request.log.error({ err: error, employeeId: id }, 'failed to remove the replaced photo');
      });
    }

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: previousKey ? 'employee.photo.change' : 'employee.photo.upload',
      entityType: 'Employee',
      entityId: employee.id,
      summary: `${previousKey ? 'Replaced' : 'Uploaded'} the profile photo for ${displayName(employee)} (${employee.employeeNumber})`,
      // The image itself is never written to the audit log - only the facts
      // about it that somebody reading the trail would want.
      before: previousKey
        ? { hasPhoto: true, contentType: employee.photoContentType }
        : { hasPhoto: false },
      after: { hasPhoto: true, contentType, bytes: body.length },
      request,
    });

    return reply.send({ data: photoResult(updated) });
  });

  /**
   * Remove.
   *
   * Idempotent: removing a photo that is not there is not an error, it is the
   * state the caller asked for. Nothing else on the record is touched - the
   * typed Photo URL, if there ever was one, is left alone and becomes the
   * avatar again; with neither, the avatar falls back to initials.
   */
  app.delete('/:id/photo', async (request, reply) => {
    const { id } = parseOrThrow(idParamSchema, request.params);
    const { auth, employee } = await authorisePhoto(request, id, 'write');

    if (!employee.photoObjectKey) {
      return reply.send({ data: photoResult(employee) });
    }

    const updated = await prisma.employee.update({
      where: { id: employee.id },
      data: {
        photoObjectKey: null,
        photoContentType: null,
        photoUpdatedAt: null,
      },
      select: {
        id: true,
        photoUrl: true,
        photoObjectKey: true,
        photoUpdatedAt: true,
      },
    });

    await deleteObject(employee.photoObjectKey).catch((error: unknown) => {
      request.log.error({ err: error, employeeId: id }, 'failed to remove the photo file');
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'employee.photo.remove',
      entityType: 'Employee',
      entityId: employee.id,
      summary: `Removed the profile photo for ${displayName(employee)} (${employee.employeeNumber})`,
      before: { hasPhoto: true, contentType: employee.photoContentType },
      after: { hasPhoto: false },
      request,
    });

    return reply.send({ data: photoResult(updated) });
  });
};

/** Re-exported so a test can assert the list the parser is registered for. */
export const SUPPORTED_PHOTO_TYPES = EMPLOYEE_PHOTO_CONTENT_TYPES;
