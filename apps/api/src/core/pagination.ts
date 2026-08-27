import type { PaginationMeta } from '@hrms/shared';

/** Turns a validated pagination query into Prisma skip/take. */
export function toSkipTake(page: number, limit: number): { skip: number; take: number } {
  return { skip: (page - 1) * limit, take: limit };
}

export function buildMeta(page: number, limit: number, total: number): PaginationMeta {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

/**
 * Whitelist-based sorting. A client can never sort by an arbitrary column,
 * which keeps the query planner honest and avoids leaking column names.
 */
export function buildOrderBy<T extends string>(
  requested: string | undefined,
  order: 'asc' | 'desc',
  allowed: readonly T[],
  fallback: T,
): Record<string, 'asc' | 'desc'> {
  const field = allowed.includes(requested as T) ? (requested as T) : fallback;
  return { [field]: order };
}
