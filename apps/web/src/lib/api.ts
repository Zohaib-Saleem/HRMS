import type { ApiErrorBody, Paginated } from '@hrms/shared';

/**
 * Thin fetch wrapper.
 *
 * Everything the UI knows about the transport lives here: the base path, the
 * credentials mode, and how an error body becomes a typed exception. Screens
 * never touch fetch directly.
 */

const BASE_URL = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, string[]>;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }

  /** True when the server rejected specific form fields. */
  get isValidation(): boolean {
    return this.status === 422 && Boolean(this.details);
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/** Raised when the network itself failed - distinct from a server rejection. */
export class NetworkError extends Error {
  constructor() {
    super('Cannot reach the server. Check that the API is running.');
    this.name = 'NetworkError';
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RequestOptions {
  method?: Method;
  body?: unknown;
  /** Sent verbatim instead of `body`, for endpoints that take raw bytes. */
  raw?: Blob;
  contentType?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${BASE_URL}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, raw, contentType, query, signal } = options;

  const headers: Record<string, string> = {};
  if (raw !== undefined) {
    // An empty type means the browser could not identify the file. Let the
    // server sniff the bytes rather than asserting something untrue.
    if (contentType) headers['Content-Type'] = contentType;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      credentials: 'same-origin',
      headers,
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new NetworkError();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const errorBody = (payload as ApiErrorBody).error ?? {
      code: 'UNKNOWN',
      message: `Request failed with status ${response.status}.`,
    };
    throw new ApiError(response.status, errorBody);
  }

  return payload as T;
}

/** Unwraps the { data } envelope every endpoint returns. */
async function unwrap<T>(path: string, options?: RequestOptions): Promise<T> {
  const payload = await request<{ data: T }>(path, options);
  return payload.data;
}

export const api = {
  /**
   * Reads the `data` out of the envelope.
   *
   * Only for endpoints whose envelope is `{ data }` and nothing else. An
   * endpoint that returns siblings of `data` - `meta`, `totals`, `range`,
   * `truncated` - needs `getPage` or `getEnvelope`, because this hands back the
   * INNER value and those siblings are lost. Nothing catches that mistake at
   * compile time: the generic is whatever the caller claims it is, and an
   * `undefined` picked up here surfaces much later as a crash somewhere that
   * had no idea it was holding the wrong shape.
   */
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    unwrap<T>(path, { ...options, method: 'GET' }),

  /** For list endpoints, which return data plus pagination meta. */
  getPage: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<Paginated<T>>(path, { ...options, method: 'GET' }),

  /**
   * The whole envelope, unwrapped by nobody.
   *
   * For the endpoints that answer with `data` alongside `totals`, `range` or
   * `truncated`. Named so that choosing it is a decision rather than an
   * accident - `get` and this differ by one level of nesting, and the type
   * system cannot tell them apart.
   */
  getEnvelope: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown) => unwrap<T>(path, { method: 'POST', body }),

  /**
   * Posts a file as the raw request body.
   *
   * Not multipart: one file, no fields, and a multipart envelope would only add
   * a filename - the one part of an upload that must never be trusted anyway.
   * The server names the stored object itself.
   *
   * `Content-Type` is the blob's own, which the server treats as a hint and
   * then checks against the file's actual header.
   */
  upload: <T>(path: string, file: Blob) =>
    unwrap<T>(path, { method: 'POST', raw: file, contentType: file.type }),
  patch: <T>(path: string, body?: unknown) => unwrap<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => unwrap<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => unwrap<T>(path, { method: 'DELETE' }),
};

/** Human-readable message for any thrown value, for toasts and error states. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof NetworkError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
