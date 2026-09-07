import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  connectorBatchSchema,
  connectorRosterSchema,
  type ConnectorBatchResult,
  type ConnectorHandshake,
  type ConnectorRosterResult,
} from '@hrms/shared';
import { logger } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';
import { parseOrThrow } from '../../core/validate.js';
import {
  ConnectorAuthError,
  ConnectorNotConfiguredError,
  authenticateConnector,
  cursorHintFor,
  driftMinutes,
  ingestConnectorBatch,
  noteConnectorContact,
  storeRoster,
} from './connector.service.js';

/**
 * The endpoints a LAN connector talks to.
 *
 * Like the ADMS routes next door, these sit outside the session-authenticated
 * API: the caller is a service on somebody's office network, not a signed-in
 * person. Unlike ADMS, the caller is software this project specifies, so it can
 * be held to a real credential and given honest JSON instead of the plain text
 * a terminal's firmware insists on.
 *
 * The surface is three calls and no more. There is no route here that reads
 * attendance back, lists devices, or hands the connector anything to do on the
 * terminal: a connector reports what it read, and that is the whole
 * relationship. Remote commands - enrol, unlock, clear the log - are exactly
 * the operations that would turn a leaked token into a door that opens.
 */

/**
 * A connector polls on a schedule it is told, then posts. Even catching up from
 * a long outage in 1000-record batches it stays far under this; the budget is
 * sized so a connector stuck in a retry loop cannot crowd out the API.
 */
const CONNECTOR_RATE_LIMIT = {
  max: 300,
  timeWindow: '1 minute',
};

/**
 * A roster is one message per terminal user, and a busy factory terminal holds
 * thousands. Larger than the global limit for that reason, and for that reason
 * only - the punch routes keep the default.
 */
const ROSTER_BODY_LIMIT = 4 * 1024 * 1024;

/** Drift worth an operator's attention rather than a shrug. */
const DRIFT_WARN_MINUTES = 5;

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/**
 * Turns a rejection into the least informative honest answer.
 *
 * 401 for anything about identity, so probing serials cannot distinguish an
 * unregistered device from a wrong token; 403 for a known device posting from a
 * network it is not allowed to post from.
 *
 * A device with no token set is the one case that answers plainly, with 409.
 * It is a half-finished setup rather than an attack, the person reading the
 * connector's log is the administrator who half-finished it, and "not
 * registered" would send them looking for the wrong problem.
 */
function rejectConnector(
  request: FastifyRequest,
  reply: FastifyReply,
  serialNumber: string | null,
  error: unknown,
): FastifyReply {
  // A malformed body is the connector's bug, not this server's, and the
  // details name the offending field. Handing it back to the shared error
  // handler is what turns it into a 400 somebody can act on instead of a 500
  // that invites the connector to retry the same bad payload forever.
  if (error instanceof ValidationError) throw error;

  if (error instanceof ConnectorNotConfiguredError) {
    logger.warn(
      { event: 'CONNECTOR_NOT_CONFIGURED', serialNumber, sourceIp: request.ip },
      'connector posted to a device with no token set',
    );
    return reply.status(409).send({ error: { message: error.message } });
  }

  if (error instanceof ConnectorAuthError) {
    logger.warn(
      {
        event: 'CONNECTOR_REJECTED',
        rejection: error.rejection,
        serialNumber,
        sourceIp: request.ip,
      },
      'connector request rejected',
    );

    const status = error.rejection === 'BLOCKED_SOURCE' ? 403 : 401;
    // WRONG_PROTOCOL and DEVICE_DISABLED describe a device an administrator
    // already knows about, so they say what is wrong. The rest are identity
    // failures and all say the same thing.
    const message =
      error.rejection === 'WRONG_PROTOCOL' || error.rejection === 'DEVICE_DISABLED'
        ? error.message
        : 'This connector is not registered.';
    return reply.status(status).send({ error: { message } });
  }

  logger.error(
    { event: 'CONNECTOR_FAILED', serialNumber, sourceIp: request.ip, err: error },
    'connector request could not be processed',
  );
  // A 5xx makes a well-behaved connector keep its batch and try again, which is
  // what should happen: the records are still on the terminal and on its disk.
  return reply.status(500).send({ error: { message: 'The batch could not be processed.' } });
}

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  const options = { config: { rateLimit: CONNECTOR_RATE_LIMIT } };

  /**
   * What the connector asks for on startup, and then periodically.
   *
   * Everything returned is configuration this system already owns, so a change
   * of timezone or polling interval is an edit on the Devices page rather than
   * a visit to whatever machine in whatever building runs the connector.
   */
  app.get('/connector/handshake', options, async (request, reply) => {
    const serial = (request.query as { serialNumber?: string }).serialNumber ?? null;
    try {
      const device = await authenticateConnector({
        token: bearerToken(request),
        serialNumber: serial ?? undefined,
        sourceIp: request.ip,
      });

      await noteConnectorContact(device.id, null);

      logger.info(
        { event: 'CONNECTOR_HANDSHAKE', deviceId: device.id, sourceIp: request.ip },
        'connector requested its configuration',
      );

      const data: ConnectorHandshake = {
        deviceId: device.id,
        deviceName: device.name,
        serialNumber: device.serialNumber,
        timeZone: device.timeZone,
        pollIntervalMinutes: device.syncIntervalMinutes,
        cursorHint: cursorHintFor(device),
        serverTime: new Date().toISOString(),
      };
      return reply.send({ data });
    } catch (error) {
      return rejectConnector(request, reply, serial, error);
    }
  });

  /**
   * The connector posts what it read off the terminal.
   *
   * The serial travels in the body rather than the URL so that the thing being
   * authenticated and the thing being written to are read from the same place;
   * a query parameter and a body that disagreed would be a bug waiting for a
   * proxy to rewrite one of them.
   */
  app.post('/connector/punches', options, async (request, reply) => {
    let serial: string | null = null;
    try {
      const input = parseOrThrow(connectorBatchSchema, request.body);
      serial = input.serialNumber;

      const device = await authenticateConnector({
        token: bearerToken(request),
        serialNumber: input.serialNumber,
        sourceIp: request.ip,
      });

      const drift = driftMinutes(input.deviceTime, device.timeZone);
      if (drift !== null && Math.abs(drift) >= DRIFT_WARN_MINUTES) {
        // Reported, never corrected. A punch is evidence of when somebody was
        // at a door, and silently shifting it would hide the one fact that
        // explains why a shift boundary is being missed.
        logger.warn(
          { event: 'CONNECTOR_CLOCK_DRIFT', deviceId: device.id, driftMinutes: drift },
          'terminal clock differs from server clock',
        );
      }

      const result = await ingestConnectorBatch({
        device,
        records: input.punches,
        connectorVersion: input.connectorVersion ?? null,
      });

      const data: ConnectorBatchResult = result;
      return reply.send({ data });
    } catch (error) {
      return rejectConnector(request, reply, serial, error);
    }
  });

  /**
   * The connector reports the terminal's enrolment list.
   *
   * A cache for the mapping screen. It never creates a mapping and never
   * creates an employee: a name typed into a terminal is not a decision about
   * whose attendance anything is.
   */
  app.post(
    '/connector/roster',
    { ...options, bodyLimit: ROSTER_BODY_LIMIT },
    async (request, reply) => {
      let serial: string | null = null;
      try {
        const input = parseOrThrow(connectorRosterSchema, request.body);
        serial = input.serialNumber;

        const device = await authenticateConnector({
          token: bearerToken(request),
          serialNumber: input.serialNumber,
          sourceIp: request.ip,
        });

        await noteConnectorContact(device.id, input.connectorVersion ?? null);
        const data: ConnectorRosterResult = await storeRoster({ device, users: input.users });
        return reply.send({ data });
      } catch (error) {
        return rejectConnector(request, reply, serial, error);
      }
    },
  );
}
