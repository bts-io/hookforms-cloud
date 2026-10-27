export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/**
 * Read `limit` and `offset` from a list request. Both must be whole numbers (limit at least 1,
 * offset at least 0); limit is capped at MAX_LIMIT. Returns an error message for bad input.
 */
export function parsePaging(
  limitRaw: string | undefined,
  offsetRaw: string | undefined,
): { limit: number; offset: number } | { error: string } {
  const isWhole = (v: string) => /^\d{1,9}$/.test(v);
  if (limitRaw !== undefined && (!isWhole(limitRaw) || Number(limitRaw) < 1)) {
    return { error: 'limit must be a whole number of at least 1' };
  }
  if (offsetRaw !== undefined && !isWhole(offsetRaw)) {
    return { error: 'offset must be a whole number of at least 0' };
  }
  return {
    limit: Math.min(limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw), MAX_LIMIT),
    offset: offsetRaw === undefined ? 0 : Number(offsetRaw),
  };
}
