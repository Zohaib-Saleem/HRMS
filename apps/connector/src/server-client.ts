import type {
  ConnectorBatch,
  ConnectorBatchResult,
  ConnectorHandshake,
  ConnectorRoster,
  ConnectorRosterResult,
} from '@hrms/shared';
import type { ConnectorConfig } from './config.js';

/**
 * The connector's half of the HRMS contract.
 *
 * Types come from `@hrms/shared`, the same definitions the server validates
 * against, so a field renamed on one side fails to compile on the other rather
 * than failing at three in the morning on somebody's office PC. They are
 * imported as types only, so none of the HRMS ships in this bundle.
 *
 * Every request is one outbound HTTPS call with a bearer token. Nothing here
 * listens, and nothing on the office network needs to be reachable.
 */

export type ServerFailure =
  /** The network, a proxy, or a server that is down. Worth retrying. */
  | 'UNREACHABLE'
  /** The HRMS answered, badly. Its problem, and worth retrying. */
  | 'SERVER_ERROR'
  /** Too fast. Worth retrying, later. */
  | 'THROTTLED'
  /** The token or the serial is wrong. Retrying will not fix it. */
  | 'REJECTED'
  /** The device exists but has no token set. An administrator must act. */
  | 'NOT_CONFIGURED'
  /** The payload was refused. This is a bug in the connector. */
  | 'INVALID';

export class ServerError extends Error {
  readonly failure: ServerFailure;
  readonly status: number | null;

  constructor(failure: ServerFailure, message: string, status: number | null = null) {
    super(message);
    this.name = 'ServerError';
    this.failure = failure;
    this.status = status;
  }

  /** Whether trying the same request again could ever succeed. */
  get retryable(): boolean {
    return this.failure === 'UNREACHABLE' || this.failure === 'SERVER_ERROR' || this.failure === 'THROTTLED';
  }
}

interface Envelope<T> {
  data?: T;
  error?: { message?: string };
}

export class ServerClient {
  constructor(private readonly config: ConnectorConfig) {}

  async handshake(serialNumber: string): Promise<ConnectorHandshake> {
    const url = `${this.config.serverUrl}/handshake?serialNumber=${encodeURIComponent(serialNumber)}`;
    return this.request<ConnectorHandshake>('GET', url);
  }

  async sendPunches(batch: ConnectorBatch): Promise<ConnectorBatchResult> {
    return this.request<ConnectorBatchResult>('POST', `${this.config.serverUrl}/punches`, batch);
  }

  async sendRoster(roster: ConnectorRoster): Promise<ConnectorRosterResult> {
    return this.request<ConnectorRosterResult>('POST', `${this.config.serverUrl}/roster`, roster);
  }

  private async request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.serverTimeoutMs),
      });
    } catch (error) {
      // DNS, TLS, refused, timed out - all the same from here, and all worth
      // trying again: an office internet connection drops, and the records are
      // still on the terminal and in this process.
      throw new ServerError('UNREACHABLE', describeNetworkError(error));
    }

    const text = await response.text().catch(() => '');
    let payload: Envelope<T> | null = null;
    try {
      payload = text ? (JSON.parse(text) as Envelope<T>) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new ServerError(
        classify(response.status),
        payload?.error?.message ?? `The HRMS answered ${response.status}.`,
        response.status,
      );
    }

    if (!payload || payload.data === undefined) {
      // A 200 with no envelope means something other than the HRMS answered -
      // a captive portal or a proxy error page, both common on office links.
      throw new ServerError('SERVER_ERROR', 'The HRMS returned a response this connector cannot read.', response.status);
    }

    return payload.data;
  }
}

function classify(status: number): ServerFailure {
  if (status === 401 || status === 403) return 'REJECTED';
  if (status === 409) return 'NOT_CONFIGURED';
  if (status === 422 || status === 400) return 'INVALID';
  if (status === 429) return 'THROTTLED';
  return 'SERVER_ERROR';
}

function describeNetworkError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'The HRMS did not answer in time.';
  }
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  const code = cause?.code ?? (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOTFOUND':
      return 'The HRMS address could not be resolved. Check serverUrl and this machine DNS.';
    case 'ECONNREFUSED':
      return 'The HRMS refused the connection. Check serverUrl and the port.';
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'The HRMS TLS certificate could not be verified.';
    default:
      return error instanceof Error ? error.message : 'The HRMS could not be reached.';
  }
}
