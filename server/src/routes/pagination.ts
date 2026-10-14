export interface Page {
  limit: number;
  offset: number;
}

function toInt(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) return null;
  return parseInt(raw, 10);
}

/**
 * Parse `limit` and `offset` from a query. A missing, non-numeric or non-positive limit gives the default,
 * a limit above `max` is capped; a bad offset is 0 (SR-10).
 */
export function parsePagination(query: Record<string, unknown>, opts: { defaultLimit?: number; maxLimit?: number } = {}): Page {
  const defaultLimit = opts.defaultLimit ?? 100;
  const maxLimit = opts.maxLimit ?? 500;
  const limit = toInt(query.limit);
  const offset = toInt(query.offset);
  return {
    limit: limit !== null && limit > 0 ? Math.min(limit, maxLimit) : defaultLimit,
    offset: offset !== null && offset > 0 ? offset : 0,
  };
}

/** Parse an optional epoch-ms timestamp query value; undefined when absent or not a number. */
export function parseTimestamp(raw: unknown): number | undefined {
  const v = toInt(raw);
  return v !== null && v >= 0 ? v : undefined;
}
