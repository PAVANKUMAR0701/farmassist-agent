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
