import { createHash } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID that is always the same for the same key, for imported seed records: re-running an import then
 * writes the same ids (an upsert), never a second copy. The time part is the record's own date (06:00 IST),
 * so seeded entries sort by date like recorded ones; the rest comes from a hash of the key.
 */
export function stableUlid(key: string, date = '2026-01-01'): string {
  let time = Date.parse(`${date}T00:30:00Z`);
  if (!Number.isFinite(time)) throw new Error(`Invalid date ${date} for stable id`);
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[time % 32]! + timePart;
    time = Math.floor(time / 32);
  }
  const hash = createHash('sha256').update(key, 'utf8').digest();
  let randomPart = '';
  for (let i = 0; i < 16; i++) randomPart += CROCKFORD[hash[i]! % 32];
  return timePart + randomPart;
}
