import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../core/logger.js';
import { zoneOffsetMinutes } from '../../core/zoned-time.js';
import { buildHandshake } from './adms.protocol.js';
import { authenticatePush, ingestPush, noteDeviceContact, PushAuthError } from './adms.service.js';

/**
 * The endpoints an ADMS terminal talks to.
 *
 * These are the only routes in the system that no signed-in user is behind. A
 * terminal cannot hold a session, present a cookie or set a header: it opens a
 * plain HTTP connection and posts text. So the entire security boundary is what
 * `authenticatePush` checks, and the surface is kept to the four calls a device
 * makes and nothing else.
 *
 * In particular there is no route here that reads attendance back out, lists
 * devices, or accepts a command for a device to run. A terminal only ever tells
 * this server what it recorded.
 *
 * Responses are plain text in the form the firmware expects. A device that gets
 * JSON logs a parse error and, on some models, stops pushing entirely.
 */

/** ZKTeco firmware sends the serial as `SN`; a few builds use lowercase. */
interface IclockQuery {
  SN?: string;
  sn?: string;
  table?: string;
  options?: string;
  Stamp?: string;
}

interface TokenParams {
  token?: string;
}

/** Terminals poll far more often than a person clicks, so they get their own budget. */
const PUSH_RATE_LIMIT = {
  max: 600,
  timeWindow: '1 minute',
};

function serialOf(request: FastifyRequest): string | undefined {
  const query = request.query as IclockQuery;
  return query.SN ?? query.sn;
}

function textReply(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply.status(status).type('text/plain; charset=utf-8').send(body);
}

/**
 * Turns a rejection into the least informative honest answer.
 *
 * 401 for anything to do with identity, so a probe cannot tell an unregistered
 * serial from a wrong token; 403 for a device that is known but not allowed to
 * push from where it is. Neither carries a reason a caller could mine.
 */
function rejectPush(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PushAuthError) {
    logger.warn(
      {
        event: 'PUSH_REJECTED',
        rejection: error.rejection,
        serialNumber: serialOf(request) ?? null,
        sourceIp: request.ip,
      },
      'device push rejected',
    );

    const status = error.rejection === 'BLOCKED_SOURCE' ? 403 : 401;
    return textReply(reply, status, 'Unauthorized');
  }

  logger.error(
    { event: 'PUSH_FAILED', serialNumber: serialOf(request) ?? null, err: error },
    'device push could not be processed',
  );
  // A 500 makes the firmware keep the batch and retry, which is what should
  // happen: the records are still on the device and nothing has been lost.
  return textReply(reply, 500, 'Error');
}

/**
 * Reads the request body as the device sent it.
 *
 * Firmware sends `text/plain`, `application/octet-stream`, or no content type
 * at all, so the parser below accepts anything and hands over the raw string.
 */
function bodyText(request: FastifyRequest): string {
  const body = request.body;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return '';
}

export async function admsRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated: this parser applies to the push routes only, and the JSON API
  // registered elsewhere keeps its own strict handling.
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, payload, done) => {
    done(null, payload);
  });

  /**
   * The device asks for its configuration, usually on boot and then hourly.
   *
   * Answering with the wrong shape here is the usual reason a terminal is
   * "connected" but never sends anything: it needs the OPTION block before it
   * will start posting.
   */
  const handshake = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const device = await authenticatePush({
        serialNumber: serialOf(request),
        token: (request.params as TokenParams).token ?? null,
        sourceIp: request.ip,
      });

      await noteDeviceContact(device.id);

      const offsetHours = Math.round(zoneOffsetMinutes(new Date(), device.timeZone) / 60);

      logger.info(
        { event: 'PUSH_HANDSHAKE', deviceId: device.id, sourceIp: request.ip },
        'device requested its configuration',
      );

      return textReply(
        reply,
        200,
        buildHandshake({
          serialNumber: device.serialNumber ?? '',
          pollIntervalSeconds: 30,
          timeZoneOffsetHours: offsetHours,
        }),
      );
    } catch (error) {
      return rejectPush(request, reply, error);
    }
  };

  /**
   * The device posts what it has recorded.
   *
   * `table=ATTLOG` carries attendance. Other tables - operation logs, user
   * enrolments, photographs - are acknowledged and discarded: accepting a
   * record type this system does not model would either lose it silently or
   * invent a meaning for it, and refusing it makes some firmware retry forever.
   */
  const receive = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const device = await authenticatePush({
        serialNumber: serialOf(request),
        token: (request.params as TokenParams).token ?? null,
        sourceIp: request.ip,
      });

      const table = ((request.query as IclockQuery).table ?? 'ATTLOG').toUpperCase();

      if (table !== 'ATTLOG') {
        await noteDeviceContact(device.id);
        logger.debug(
          { event: 'PUSH_IGNORED_TABLE', deviceId: device.id, table },
          'device posted a table this system does not store',
        );
        return textReply(reply, 200, 'OK');
      }

      const result = await ingestPush({ device, body: bodyText(request) });

      // The count is how many records were taken off the device's hands, which
      // includes lines that could not be read: they are recorded as permanent
      // failures here and resending them would not make them readable. A
      // smaller number makes the firmware resend the whole batch, and while the
      // fingerprint index would absorb the repeat, it would repeat forever.
      return textReply(reply, 200, `OK: ${result.received}`);
    } catch (error) {
      return rejectPush(request, reply, error);
    }
  };

  /**
   * The device asks whether the server wants anything done.
   *
   * The answer is always no. Remote commands - unlock, enrol, reboot, clear the
   * log - are exactly the operations that turn an HRMS bug into a door that
   * opens, and nothing in this system needs them.
   */
  const getRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const device = await authenticatePush({
        serialNumber: serialOf(request),
        token: (request.params as TokenParams).token ?? null,
        sourceIp: request.ip,
      });
      await noteDeviceContact(device.id);
      return textReply(reply, 200, 'OK');
    } catch (error) {
      return rejectPush(request, reply, error);
    }
  };

  /** The device reports the result of a command. There are none, so this just acknowledges. */
  const deviceCmd = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const device = await authenticatePush({
        serialNumber: serialOf(request),
        token: (request.params as TokenParams).token ?? null,
        sourceIp: request.ip,
      });
      await noteDeviceContact(device.id);
      return textReply(reply, 200, 'OK');
    } catch (error) {
      return rejectPush(request, reply, error);
    }
  };

  const options = { config: { rateLimit: PUSH_RATE_LIMIT } };

  app.get('/iclock/cdata', options, handshake);
  app.post('/iclock/cdata', options, receive);
  app.get('/iclock/getrequest', options, getRequest);
  app.post('/iclock/devicecmd', options, deviceCmd);

  // The same four calls under a secret path segment, for firmware that lets the
  // server URL carry one. It is the only way to give a pushing device something
  // closer to a credential than a serial number anyone can read off the case.
  app.get('/iclock/:token/cdata', options, handshake);
  app.post('/iclock/:token/cdata', options, receive);
  app.get('/iclock/:token/getrequest', options, getRequest);
  app.post('/iclock/:token/devicecmd', options, deviceCmd);
}
