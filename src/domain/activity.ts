import { newEntryId, parseEntryId } from './entry-id.js';

export const ACTIVITY_TYPES = ['milking', 'vaccination', 'sowing', 'harvesting', 'irrigation', 'other'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface FarmActivity {
  /** Public id such as act_20261014_01JABCDEF... */
  entryId: string;
  farmId: string;
  /** Farm-local calendar date (Asia/Kolkata), YYYY-MM-DD. */
  date: string;
  activityType: ActivityType;
  /** Which animal or field, in the farmer's words, e.g. "brown cow", "north field". */
  animalOrField?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface NewActivity {
  farmId: string;
  date: string;
  activityType: ActivityType;
  animalOrField?: string;
  note?: string;
}

export function newActivityEntryId(date: string): string {
  return newEntryId('activity', date);
}

export function parseActivityEntryId(entryId: string): { date: string; ulid: string } | undefined {
  const parsed = parseEntryId(entryId);
  return parsed?.kind === 'activity' ? { date: parsed.date, ulid: parsed.ulid } : undefined;
}
