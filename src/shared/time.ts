/** All "today" / "this month" logic uses the farmer's local time zone, never the server's (Lambda runs in UTC). */
export const FARM_TIME_ZONE = 'Asia/Kolkata';

const isoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: FARM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Returns the calendar date in Asia/Kolkata as YYYY-MM-DD. */
export function todayInFarmTimeZone(now: Date = new Date()): string {
  return isoDateFormatter.format(now);
}

/** True for a real calendar date written as YYYY-MM-DD (rejects 2026-02-30, 2026-13-01, 26-1-5). */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
