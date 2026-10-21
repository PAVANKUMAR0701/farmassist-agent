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

// Calendar arithmetic on YYYY-MM-DD strings. Done in UTC so no time-zone offset can shift the day.
const toUtc = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);
const fromUtc = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(isoDate: string, days: number): string {
  const d = toUtc(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** Whole days from `from` to `to` (0 when equal). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

export const NAMED_PERIODS = ['today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'last_month', 'last_6_months'] as const;
export type NamedPeriod = (typeof NAMED_PERIODS)[number];

export interface DateRange {
  from: string;
  to: string;
}

/**
 * Turns a named period into concrete dates, relative to `today` (already in farm time).
 * Weeks start on Monday. "this_week" and "this_month" run up to and including today.
 */
export function resolveNamedPeriod(period: NamedPeriod, today: string): DateRange {
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'this_week': {
      const mondayOffset = (toUtc(today).getUTCDay() + 6) % 7; // Monday=0 ... Sunday=6
      return { from: addDays(today, -mondayOffset), to: today };
    }
    case 'last_7_days':
      return { from: addDays(today, -6), to: today };
    case 'this_month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_month': {
      const firstOfThisMonth = `${today.slice(0, 7)}-01`;
      const lastOfPrevMonth = addDays(firstOfThisMonth, -1);
      return { from: `${lastOfPrevMonth.slice(0, 7)}-01`, to: lastOfPrevMonth };
    }
    case 'last_6_months': {
      // This month and the five before it, from the 1st: on 2026-10-21 that is 2026-05-01 to 2026-10-21.
      const [year, month] = today.split('-').map(Number) as [number, number];
      return { from: new Date(Date.UTC(year, month - 6, 1)).toISOString().slice(0, 10), to: today };
    }
  }
}
