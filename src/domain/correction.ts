import type { ExpenseCategory, ExpenseEntry } from './expense.js';

/** The correctable part of an expense. */
export interface ExpenseSnapshot {
  amountPaise: number;
  category: ExpenseCategory;
  note?: string;
}

/** Requested changes. note: "" (or whitespace) removes the note. */
export interface ExpenseChanges {
  amountPaise?: number | undefined;
  category?: ExpenseCategory | undefined;
  note?: string | undefined;
}

export type CorrectableField = 'amountPaise' | 'category' | 'note';

/** Audit record kept for every correction: what changed, from what, to what, and when. */
export interface CorrectionRecord {
  correctionId: string;
  farmId: string;
  entryId: string;
  before: ExpenseSnapshot;
  after: ExpenseSnapshot;
  changedFields: CorrectableField[];
  reason?: string;
  correctedAt: string;
  fromVersion: number;
  toVersion: number;
}

export function snapshotOf(entry: ExpenseEntry): ExpenseSnapshot {
  return { amountPaise: entry.amountPaise, category: entry.category, ...(entry.note ? { note: entry.note } : {}) };
}

/** Applies changes to a snapshot and reports which fields really changed (a "change" to the same value is ignored). */
export function applyChanges(before: ExpenseSnapshot, changes: ExpenseChanges): { after: ExpenseSnapshot; changedFields: CorrectableField[] } {
  const amountPaise = changes.amountPaise ?? before.amountPaise;
  const category = changes.category ?? before.category;
  const note = changes.note === undefined ? before.note : changes.note.trim() || undefined;
  const after: ExpenseSnapshot = { amountPaise, category, ...(note ? { note } : {}) };

  const changedFields: CorrectableField[] = [];
  if (after.amountPaise !== before.amountPaise) changedFields.push('amountPaise');
  if (after.category !== before.category) changedFields.push('category');
  if (after.note !== before.note) changedFields.push('note');
  return { after, changedFields };
}
