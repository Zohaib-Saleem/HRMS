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
  const { method = 'GET', body, query, signal } = options;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
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
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    unwrap<T>(path, { ...options, method: 'GET' }),

  /** For list endpoints, which return data plus pagination meta. */
  getPage: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<Paginated<T>>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown) => unwrap<T>(path, { method: 'POST', body }),
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
