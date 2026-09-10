// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

/**
 * The envelope contract, pinned.
 *
 * One mistake took the corrections page down and emptied two employee pickers
 * without a word: `api.get` unwraps `{ data }` and hands back the INNER value,
 * so calling it on an endpoint that answers `{ data, meta, totals, range }`
 * quietly discards every sibling. `query.data.meta` was then `undefined`,
 * `Pagination` destructured it, and the screen fell over.
 *
 * Nothing catches that at compile time - the generic is whatever the caller
 * claims - so it is caught here instead: these tests state, in one place, what
 * each of the three readers returns, and any change to that is deliberate.
 */

const envelope = {
  data: [{ id: 'a' }],
  meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
  totals: { present: 1 },
  range: { from: '2026-09-01', to: '2026-09-30' },
};

const respond = (body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response);

beforeEach(() => {
  vi.stubGlobal('fetch', respond(envelope));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which reader keeps the envelope', () => {
  it('get returns only the inner data, dropping every sibling', async () => {
    const result = await api.get<unknown>('/attendance/monthly');
    expect(result).toEqual(envelope.data);
    // The trap in one line: what looks like a response object is an array.
    expect((result as { meta?: unknown }).meta).toBeUndefined();
  });

  it('getPage keeps data and meta, which is what Pagination needs', async () => {
    const result = await api.getPage<{ id: string }>('/employees');
    expect(result.data).toEqual(envelope.data);
    expect(result.meta).toEqual(envelope.meta);
  });

  it('getEnvelope keeps totals and range as well', async () => {
    const result = await api.getEnvelope<typeof envelope>('/attendance/monthly');
    expect(result).toEqual(envelope);
    expect(result.totals).toEqual(envelope.totals);
    expect(result.range).toEqual(envelope.range);
  });
});

describe('the shape Pagination is given', () => {
  /**
   * An empty result is an empty ARRAY, and an array is truthy. A `query.data ?`
   * guard therefore let the wrong shape straight through to a component that
   * destructures `meta` - which is why an empty month crashed exactly like a
   * full one.
   */
  it('an empty page still carries meta, and an unwrapped one does not', async () => {
    vi.stubGlobal('fetch', respond({ ...envelope, data: [] }));

    const unwrapped = await api.get<{ meta?: unknown }>('/attendance/monthly');
    expect(Array.isArray(unwrapped)).toBe(true);
    expect(Boolean(unwrapped)).toBe(true); // truthy, and still the wrong shape
    expect(unwrapped.meta).toBeUndefined();

    const whole = await api.getEnvelope<typeof envelope>('/attendance/monthly');
    expect(whole.data).toEqual([]);
    expect(whole.meta).toEqual(envelope.meta);
  });
});
