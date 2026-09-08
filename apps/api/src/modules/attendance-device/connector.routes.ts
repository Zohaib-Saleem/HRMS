import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  connectorBatchSchema,
  connectorRosterSchema,
  type ConnectorAgentBatchResult,
  type ConnectorAgentHeldResult,
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
  connectorIngestIsLive,
  cursorHintFor,
  agentReportedZone,
  describeAgentBatch,
  describeAgentEnvelope,
  describeAgentPins,
  describeAgentSpan,
  describeAgentVocabulary,
  driftMinutes,
  ingestConnectorBatch,
  noteConnectorContact,
  normaliseAgentRecords,
  readAgentEnvelope,
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

/**
 * An agent that batches on its own terms can send a long backlog in one body.
 *
 * Sized to hold one terminal's full history rather than to express a preference
 * about batch size: this server cannot change how the agent batches, and a 413
 * would look to it exactly like the 404 it has been retrying against.
 */
const AGENT_BODY_LIMIT = 12 * 1024 * 1024;

/**
 * How long a held agent is asked to wait.
 *
 * Long enough that a held agent is not retrying every thirty seconds for days,
 * short enough that releasing the gate is noticed within a few minutes.
 */
const HOLD_RETRY_AFTER_SECONDS = 300;

/** Drift worth an operator's attention rather than a shrug. */
const DRIFT_WARN_MINUTES = 5;

/** A single header value, trimmed, or null. Never used for the credential. */
function asHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
}

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

  /**
   * The bare path, for an agent that reads the advertised URL as the endpoint.
   *
   * The Devices page prints `<origin>/connector` as the address to configure,
   * and the agent running beside the K50 took that string literally: it posts
   * its whole envelope here rather than to `/connector/punches`. Both readings
   * of that URL are defensible and only one of them had a route, which is the
   * entire reason a working agent reading a working terminal delivered nothing.
   *
   * So the server learns the second dialect. Authentication is the same
   * function the other routes use, and everything past normalisation is the
   * same ingest the other routes use - the translation is the only new thing,
   * and it is deliberately the only new thing.
   *
   * Nothing here is stored unless the terminal's serial has been named in
   * `CONNECTOR_INGEST_LIVE_SERIALS`. An agent holding a long backlog is
   * authenticated, its records read and counted, and then answered 503 with
   * nothing written, so the backlog stays where it is until somebody decides
   * otherwise. 503 rather than 200 because an agent told "success" is entitled
   * to advance its cursor and forget what it holds; the wrong reply here costs
   * a month of attendance that exists nowhere else.
   */
  app.post('/connector', { ...options, bodyLimit: AGENT_BODY_LIMIT }, async (request, reply) => {
    let serial: string | null = null;
    try {
      const input = readAgentEnvelope(request.body);

      // The headers are a fallback, not the source of truth: an agent that puts
      // the serial only in `Device-Serial` is still telling this server which
      // terminal it read, and refusing it over the placement of a value would
      // be pedantry with a month of attendance riding on it.
      const headerSerial = asHeader(request, 'device-serial');
      serial = input.deviceSerial ?? headerSerial;
      const connectorVersion =
        input.connectorVersion ?? asHeader(request, 'x-connector-version');
      const batchId = input.batchId ?? asHeader(request, 'x-batch-id');

      // Logged before authentication, so a dialect this server cannot read is
      // diagnosable even when the credential is wrong. Key names and value
      // types only - never a value, and never a header that carries the token.
      logger.info(
        {
          event: 'CONNECTOR_AGENT_ENVELOPE',
          serialNumber: serial,
          sourceIp: request.ip,
          envelope: describeAgentEnvelope(request.body),
          records: input.records.length,
          malformed: input.malformed,
        },
        'agent envelope received',
      );

      const device = await authenticateConnector({
        token: bearerToken(request),
        serialNumber: serial ?? undefined,
        sourceIp: request.ip,
      });

      // Reported, never acted on: the serial is what selects the device, and an
      // agent's own idea of a device id has no authority here.
      if (input.deviceId && input.deviceId !== device.id && input.deviceId !== device.serialNumber) {
        logger.warn(
          { event: 'CONNECTOR_AGENT_DEVICE_ID', deviceId: device.id, claimed: input.deviceId },
          'agent reported a device id this server does not use',
        );
      }

      const drift = driftMinutes(input.deviceTime, device.timeZone);
      if (drift !== null && Math.abs(drift) >= DRIFT_WARN_MINUTES) {
        logger.warn(
          { event: 'CONNECTOR_CLOCK_DRIFT', deviceId: device.id, driftMinutes: drift },
          'terminal clock differs from server clock',
        );
      }

      const read = normaliseAgentRecords(input.records, device.timeZone);
      const shape = describeAgentBatch(input.records);
      const live = connectorIngestIsLive(device.serialNumber);

      // A zone the agent believes in that this server does not is worth saying
      // out loud: it is the difference between an arrival and an overnight
      // shift, and it is invisible in the records themselves.
      const claimedZone = agentReportedZone(input.records);
      if (claimedZone && claimedZone !== device.timeZone) {
        logger.warn(
          {
            event: 'CONNECTOR_AGENT_ZONE',
            deviceId: device.id,
            configured: device.timeZone,
            reported: claimedZone,
          },
          'agent reports a different terminal timezone than the one configured',
        );
      }

      // Field names, counts and the shape of a timestamp with its digits
      // masked. No PIN, no punch time and no credential: this line exists to
      // prove the dialect was read correctly, not to hold a copy of the data.
      logger.info(
        {
          event: 'CONNECTOR_AGENT_BATCH',
          deviceId: device.id,
          batchId,
          source: input.source ?? null,
          connectorVersion,
          received: input.records.length,
          readable: read.punches.length,
          unreadable: read.rejected.length + input.malformed,
          duplicateHashes: read.duplicateHashes,
          resolvedKeys: read.resolvedKeys,
          recordKeys: shape.recordKeys,
          timestampShape: shape.timestampShape,
          vocabulary: describeAgentVocabulary(input.records),
          // The PIN roster of the batch in hand. Logged so the terminal's
          // numbers can be mapped to people before any of it is stored - which
          // is the step that has to happen first, since nothing here knows yet
          // whose attendance any of these readings are.
          pins: describeAgentPins(input.records),
          span: describeAgentSpan(input.records, device.timeZone),
          ingest: live ? 'live' : 'held',
        },
        live ? 'agent batch accepted for ingest' : 'agent batch read and held, nothing stored',
      );

      if (!live) {
        const data: ConnectorAgentHeldResult = {
          accepted: false,
          held: true,
          batchId,
          received: input.records.length,
          readable: read.punches.length,
          unreadable: read.rejected.length + input.malformed,
          retryAfterSeconds: HOLD_RETRY_AFTER_SECONDS,
          message:
            'This endpoint is reachable and your credentials are accepted, but ingest for this terminal has not been released yet. Keep your queue and retry later.',
        };
        return reply
          .header('Retry-After', String(HOLD_RETRY_AFTER_SECONDS))
          .status(503)
          .send({ data, error: { code: 'CONNECTOR_INGEST_HELD', message: data.message } });
      }

      const result = await ingestConnectorBatch({
        device,
        records: read.punches,
        connectorVersion,
      });

      const data: ConnectorAgentBatchResult = {
        ...result,
        accepted: true,
        held: false,
        batchId,
        received: input.records.length,
        // Records this server could not translate never reached the ingest, so
        // they are added here rather than being quietly absent from the count.
        errors: result.errors + read.rejected.length + input.malformed,
      };
      return reply.send({ data });
    } catch (error) {
      return rejectConnector(request, reply, serial, error);
    }
  });
}
