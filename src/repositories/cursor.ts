import type { ExpenseCategory } from '../domain/expense.js';

/**
 * Opaque pagination cursor. It records where the previous page stopped (date + ulid) and the exact query it
 * belongs to, so a cursor cannot be replayed against a different date range, category or farm.
 */
export interface CursorPosition {
  date: string;
  ulid: string;
}

interface CursorPayload extends CursorPosition {
  v: 1;
  farmId: string;
  from: string;
  to: string;
  category: ExpenseCategory | null;
}

export class InvalidCursorError extends Error {
  constructor() {
    super('cursor is invalid or belongs to a different query; repeat the request without a cursor');
    this.name = 'InvalidCursorError';
  }
}

interface CursorQuery {
  farmId: string;
  from: string;
  to: string;
  category?: ExpenseCategory | undefined;
}

export function encodeCursor(position: CursorPosition, query: CursorQuery): string {
  const payload: CursorPayload = { v: 1, ...position, farmId: query.farmId, from: query.from, to: query.to, category: query.category ?? null };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, query: CursorQuery): CursorPosition {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const matchesQuery =
    payload?.v === 1 &&
    payload.farmId === query.farmId &&
    payload.from === query.from &&
    payload.to === query.to &&
    payload.category === (query.category ?? null);
  const wellFormed =
    typeof payload?.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(payload.date) &&
    typeof payload.ulid === 'string' &&
    /^[0-9A-HJKMNP-TV-Z]{26}$/.test(payload.ulid) &&
    payload.date >= query.from &&
    payload.date <= query.to;
  if (!matchesQuery || !wellFormed) throw new InvalidCursorError();
  return { date: payload.date, ulid: payload.ulid };
}
