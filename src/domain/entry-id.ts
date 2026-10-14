import { ulid } from 'ulid';

/**
 * Public entry ids look like exp_20261014_01JABC... or act_20261014_01JABC...
 * The kind and date let the server rebuild the DynamoDB sort key without searching; the ULID sorts by creation time.
 */
export type EntryKind = 'expense' | 'activity';

const PREFIX: Record<EntryKind, string> = { expense: 'exp', activity: 'act' };
const ENTRY_ID_PATTERN = /^(exp|act)_(\d{4})(\d{2})(\d{2})_([0-9A-HJKMNP-TV-Z]{26})$/;

export function newEntryId(kind: EntryKind, date: string): string {
  return `${PREFIX[kind]}_${date.replaceAll('-', '')}_${ulid()}`;
}

export function parseEntryId(entryId: string): { kind: EntryKind; date: string; ulid: string } | undefined {
  const match = ENTRY_ID_PATTERN.exec(entryId);
  if (!match) return undefined;
  const [, prefix, year, month, day, id] = match;
  return { kind: prefix === 'exp' ? 'expense' : 'activity', date: `${year}-${month}-${day}`, ulid: id! };
}
