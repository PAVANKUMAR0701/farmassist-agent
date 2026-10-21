/** Helpers shared by the herd, milk, crop, insurance and reminder tools. */
import { z } from 'zod';
import type { FarmRecord, RecordStore } from '../repositories/record-store.js';
import { daysBetween, isValidIsoDate } from '../shared/time.js';
import { ToolUserError } from './tool-errors.js';

export const ANIMAL_TYPES = ['cow', 'buffalo', 'bull', 'calf', 'heifer', 'goat', 'sheep', 'chicken', 'other'] as const;
export type AnimalType = (typeof ANIMAL_TYPES)[number];
export const ANIMAL_STATUSES = ['active', 'sold', 'died'] as const;

export interface AnimalData extends Record<string, unknown> {
  name?: string;
  type: AnimalType;
  breed?: string;
  sex?: 'female' | 'male';
  tagNumber?: string;
  birthDate?: string;
  motherName?: string;
  acquiredDate?: string;
  status: (typeof ANIMAL_STATUSES)[number];
  statusDate?: string;
  notes?: string;
  /** Set by imported demo data (src/demo/krishna-farm.ts); the farmer's own records do not have these. */
  nameKn?: string;
  motherId?: string;
  lactationStatus?: string;
  healthStatus?: string;
  usualDailyMillilitres?: number;
  purchaseValuePaise?: number;
  milkFeeding?: string;
  sourceId?: string;
  demo?: boolean;
}

/** Insurance counts as "due soon" this many days before it ends. */
export const INSURANCE_DUE_SOON_DAYS = 30;
export type InsuranceStatus = 'overdue' | 'due_soon' | 'active';

/**
 * A policy's status worked out from its end date on `today` (farm time): overdue once the end date has passed,
 * due soon within INSURANCE_DUE_SOON_DAYS, active otherwise. Stored statuses are never trusted for this.
 */
export function insuranceStatus(endDate: string, today: string): { status: InsuranceStatus; daysLeft: number } {
  const daysLeft = daysBetween(today, endDate);
  return { status: daysLeft < 0 ? 'overdue' : daysLeft <= INSURANCE_DUE_SOON_DAYS ? 'due_soon' : 'active', daysLeft };
}

export const animalRefInput = {
  animalId: z.string().max(40).optional().describe('Id of the animal (from register_animal or list_animals). Preferred when you have it.'),
  animalName: z.string().trim().min(1).max(40).optional().describe('The animal\'s name, as the farmer says it, when you do not have its id.'),
};

/** Optional text field: trimmed, and an empty string counts as not given. */
export const optionalText = (max: number, description: string) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : undefined)).describe(description);

/** A calendar date that may be in the future (reminders, insurance end dates). */
export function requireDate(name: string, value: string): string {
  if (!isValidIsoDate(value)) throw new ToolUserError(`${name} "${value}" is not a real calendar date in YYYY-MM-DD format`);
  return value;
}

export const sameName = (a: string | undefined, b: string | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export const animalLabel = (a: AnimalData) => (a.name ? `${a.name} (${a.type}${a.breed ? `, ${a.breed}` : ''})` : `${a.type}${a.tagNumber ? ` tag ${a.tagNumber}` : ''}`);

/** "2 years 3 months", "5 months", "12 days": worked out in code from the birth date. */
export function ageDisplay(birthDate: string | undefined, today: string): string | undefined {
  if (!birthDate || birthDate > today) return undefined;
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let months = (ty - by) * 12 + (tm - bm) - (td < bd ? 1 : 0);
  if (months < 1) {
    const days = daysBetween(birthDate, today);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  const years = Math.floor(months / 12);
  months %= 12;
  const parts = [years ? `${years} year${years === 1 ? '' : 's'}` : '', months ? `${months} month${months === 1 ? '' : 's'}` : ''].filter(Boolean);
  return parts.join(' ');
}

/**
 * Finds the animal a request means: by id, or by name among active animals. Never guesses: an unknown or
 * ambiguous name is an error that lists what exists, so the model can ask the farmer.
 */
export async function resolveAnimal(
  records: RecordStore,
  farmId: string,
  ref: { animalId?: string | undefined; animalName?: string | undefined },
  opts: { includeInactive?: boolean } = {},
): Promise<FarmRecord<AnimalData>> {
  if (ref.animalId) {
    const animal = await records.get<AnimalData>(farmId, ref.animalId);
    if (!animal || animal.kind !== 'animal') throw new ToolUserError(`no animal with id ${ref.animalId} was found; use list_animals to find it`);
    return animal;
  }
  if (!ref.animalName) throw new ToolUserError('say which animal: give animalId or animalName');
  const all = await records.list<AnimalData>(farmId, 'animal');
  const candidates = all.filter((a) => (opts.includeInactive || a.data.status === 'active') && (sameName(a.data.name, ref.animalName) || sameName(a.data.tagNumber, ref.animalName)));
  if (candidates.length === 1) return candidates[0]!;
  const names = all.filter((a) => a.data.status === 'active' && a.data.name).map((a) => a.data.name);
  if (candidates.length === 0) {
    throw new ToolUserError(
      `no ${opts.includeInactive ? '' : 'active '}animal named "${ref.animalName}" is registered${names.length ? ` (registered: ${names.join(', ')})` : ' (no animals are registered yet; use register_animal first)'}`,
    );
  }
  throw new ToolUserError(`${candidates.length} animals are called "${ref.animalName}": ${candidates.map((c) => `${animalLabel(c.data)} id ${c.id}`).join('; ')}. Ask the farmer which one, then use its animalId`);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 cows, 1 calf" in a stable order. */
export function countByType(animals: ReadonlyArray<{ type: string }>): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const a of animals) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  return ANIMAL_TYPES.filter((t) => counts.has(t)).map((type) => ({ type, count: counts.get(type)! }));
}

const PLURAL_TYPES: Record<string, string> = { calf: 'calves', sheep: 'sheep', buffalo: 'buffaloes' };

/** Shown with every imported demo record, so nobody takes it for a real farm's data. */
export const DEMO_NOTICE = 'Demo data: synthetic records for a demo farm, not real farm records.';
/** Shown with every treatment or vaccination record. FarmAssist never gives medicine or dose advice. */
export const VET_NOTICE = 'A veterinarian must decide any medicine, dose and milk withdrawal period; these records are not veterinary advice.';
export const describeCounts = (counts: Array<{ type: string; count: number }>) =>
  counts.map((c) => `${c.count} ${c.count === 1 ? c.type : (PLURAL_TYPES[c.type] ?? `${c.type}s`)}`).join(', ');
