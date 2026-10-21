/**
 * Storage for the farm records beyond the money ledger: animals, milk, crops, harvests, insurance, reminders.
 * One generic, farm-scoped store keeps them consistent (same ids, versions, idempotency and caps as the ledger)
 * without a table or repository per kind.
 *
 * Ids and sort keys (all under PK = FARM#<farmId>):
 *   animal     ani_<ulid>                 ANIMAL#<ulid>
 *   milk       milk_<yyyymmdd>_<ulid>     MILK#<yyyy-mm-dd>#<ulid>
 *   crop       crop_<ulid>                CROP#<ulid>
 *   harvest    hrv_<cropUlid>_<ulid>      HARVEST#<cropUlid>#<ulid>
 *   insurance  ins_<ulid>                 INSURANCE#<ulid>
 *   reminder   rem_<yyyymmdd>_<ulid>      REMINDER#<yyyy-mm-dd>#<ulid>
 *   egg        egg_<yyyymmdd>_<ulid>      EGG#<yyyy-mm-dd>#<ulid>
 *   treatment  trt_<yyyymmdd>_<ulid>      TREATMENT#<yyyy-mm-dd>#<ulid>
 *   vaccination vac_<ulid>                VACCINATION#<ulid>
 *   feed stock feed_<ulid>                FEED#<ulid>
 */
import { ulid } from 'ulid';
import { ConcurrentModificationError, EntryNotFoundError, IdempotencyConflictError, MAX_SUMMARY_ENTRIES, TooManyEntriesError, type Idempotency } from './ledger-repository.js';

export type RecordKind = 'animal' | 'milk' | 'crop' | 'harvest' | 'insurance' | 'reminder' | 'egg' | 'treatment' | 'vaccination' | 'feed';

export interface FarmRecord<T = Record<string, unknown>> {
  id: string;
  kind: RecordKind;
  farmId: string;
  data: T;
  createdAt: string;
  updatedAt: string;
  version: number;
}

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const DATED: Partial<Record<RecordKind, true>> = { milk: true, reminder: true, egg: true, treatment: true };
const PREFIX: Record<RecordKind, { id: string; sk: string }> = {
  animal: { id: 'ani', sk: 'ANIMAL' },
  milk: { id: 'milk', sk: 'MILK' },
  crop: { id: 'crop', sk: 'CROP' },
  harvest: { id: 'hrv', sk: 'HARVEST' },
  insurance: { id: 'ins', sk: 'INSURANCE' },
  reminder: { id: 'rem', sk: 'REMINDER' },
  egg: { id: 'egg', sk: 'EGG' },
  treatment: { id: 'trt', sk: 'TREATMENT' },
  vaccination: { id: 'vac', sk: 'VACCINATION' },
  feed: { id: 'feed', sk: 'FEED' },
};

/** A new id. Dated kinds need `date` (YYYY-MM-DD); harvests need the crop's id. */
export function newRecordId(kind: RecordKind, opts: { date?: string; cropId?: string } = {}): string {
  return recordIdWith(kind, ulid(), opts);
}

/** The id of a kind with a given ULID (seeded demo records use stable ULIDs, see src/domain/stable-id.ts). */
export function recordIdWith(kind: RecordKind, id: string, opts: { date?: string; cropId?: string } = {}): string {
  if (DATED[kind]) return `${PREFIX[kind].id}_${opts.date!.replaceAll('-', '')}_${id}`;
  if (kind === 'harvest') return `hrv_${parseRecordId(opts.cropId ?? '')!.ulid}_${id}`;
  return `${PREFIX[kind].id}_${id}`;
}

export interface ParsedRecordId {
  kind: RecordKind;
  ulid: string;
  date?: string;
  cropUlid?: string;
  sortKey: string;
}

/** Parses and validates a record id; undefined for anything malformed (never trust a model-supplied id). */
export function parseRecordId(id: string): ParsedRecordId | undefined {
  for (const [kind, p] of Object.entries(PREFIX) as Array<[RecordKind, { id: string; sk: string }]>) {
    if (DATED[kind]) {
      const m = new RegExp(`^${p.id}_(\\d{4})(\\d{2})(\\d{2})_(${ULID})$`).exec(id);
      if (m) return { kind, ulid: m[4]!, date: `${m[1]}-${m[2]}-${m[3]}`, sortKey: `${p.sk}#${m[1]}-${m[2]}-${m[3]}#${m[4]}` };
    } else if (kind === 'harvest') {
      const m = new RegExp(`^hrv_(${ULID})_(${ULID})$`).exec(id);
      if (m) return { kind, ulid: m[2]!, cropUlid: m[1]!, sortKey: `HARVEST#${m[1]}#${m[2]}` };
    } else {
      const m = new RegExp(`^${p.id}_(${ULID})$`).exec(id);
      if (m) return { kind, ulid: m[1]!, sortKey: `${p.sk}#${m[1]}` };
    }
  }
  return undefined;
}

/** Which records of a kind to read: a date range for dated kinds, or one crop's harvests. */
export interface RecordQuery {
  from?: string;
  to?: string;
  cropId?: string;
}

/** Sort-key bounds for a query (inclusive). "~" sorts after every ULID character. */
export function sortKeyRange(kind: RecordKind, query: RecordQuery = {}): { lo: string; hi: string } {
  const sk = PREFIX[kind].sk;
  if (DATED[kind] && (query.from || query.to)) return { lo: `${sk}#${query.from ?? '0000-00-00'}#`, hi: `${sk}#${query.to ?? '9999-99-99'}#~` };
  if (kind === 'harvest' && query.cropId) {
    const crop = parseRecordId(query.cropId)!.ulid;
    return { lo: `HARVEST#${crop}#`, hi: `HARVEST#${crop}#~` };
  }
  return { lo: `${sk}#`, hi: `${sk}#~` };
}

export interface RecordStore {
  /** Creates a record. With idempotency, a retry with the same clientRequestId returns the original. */
  create<T extends Record<string, unknown>>(farmId: string, id: string, data: T, idempotency?: Idempotency): Promise<{ record: FarmRecord<T>; duplicate: boolean }>;
  /**
   * The record an earlier request with this clientRequestId created, or undefined if there was none.
   * Throws IdempotencyConflictError if the id was used for a different request.
   */
  findCreated<T extends Record<string, unknown>>(farmId: string, idempotency: Idempotency): Promise<FarmRecord<T> | undefined>;
  get<T extends Record<string, unknown>>(farmId: string, id: string): Promise<FarmRecord<T> | undefined>;
  /** Replaces the data if the stored version still equals expectedVersion (optimistic locking). */
  update<T extends Record<string, unknown>>(farmId: string, id: string, expectedVersion: number, data: T): Promise<FarmRecord<T>>;
  /** Every record of a kind (oldest first by sort key). Throws TooManyEntriesError above MAX_SUMMARY_ENTRIES. */
  list<T extends Record<string, unknown>>(farmId: string, kind: RecordKind, query?: RecordQuery): Promise<Array<FarmRecord<T>>>;
  /**
   * Writes a record with a known id, replacing whatever is stored under it (version 1, timestamps `at`).
   * Only for importing seed data with stable ids: re-running the import rewrites the same items, never adds more.
   */
  upsert<T extends Record<string, unknown>>(farmId: string, id: string, data: T, at: string): Promise<FarmRecord<T>>;
}

/** In-memory store for tests and keyless local development. Mirrors the DynamoDB behaviour. */
export class InMemoryRecordStore implements RecordStore {
  private readonly items = new Map<string, FarmRecord>();
  private readonly idempotency = new Map<string, { id: string; fingerprint: string }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private key = (farmId: string, id: string) => `${farmId}|${parseRecordId(id)!.sortKey}`;

  async create<T extends Record<string, unknown>>(farmId: string, id: string, data: T, idempotency?: Idempotency) {
    if (idempotency) {
      const marker = this.idempotency.get(`${farmId}|${idempotency.clientRequestId}`);
      if (marker) {
        if (marker.fingerprint !== idempotency.fingerprint) throw new IdempotencyConflictError(idempotency.clientRequestId);
        return { record: this.items.get(this.key(farmId, marker.id)) as FarmRecord<T>, duplicate: true };
      }
    }
    const parsed = parseRecordId(id);
    if (!parsed) throw new Error(`Invalid record id ${id}`);
    const timestamp = this.now().toISOString();
    const record: FarmRecord<T> = { id, kind: parsed.kind, farmId, data: structuredClone(data), createdAt: timestamp, updatedAt: timestamp, version: 1 };
    this.items.set(this.key(farmId, id), record as FarmRecord);
    if (idempotency) this.idempotency.set(`${farmId}|${idempotency.clientRequestId}`, { id, fingerprint: idempotency.fingerprint });
    return { record: structuredClone(record), duplicate: false };
  }

  async findCreated<T extends Record<string, unknown>>(farmId: string, idempotency: Idempotency) {
    const marker = this.idempotency.get(`${farmId}|${idempotency.clientRequestId}`);
    if (!marker) return undefined;
    if (marker.fingerprint !== idempotency.fingerprint) throw new IdempotencyConflictError(idempotency.clientRequestId);
    return this.get<T>(farmId, marker.id);
  }

  async get<T extends Record<string, unknown>>(farmId: string, id: string) {
    if (!parseRecordId(id)) return undefined;
    const record = this.items.get(this.key(farmId, id));
    return record ? (structuredClone(record) as FarmRecord<T>) : undefined;
  }

  async update<T extends Record<string, unknown>>(farmId: string, id: string, expectedVersion: number, data: T) {
    const current = parseRecordId(id) ? this.items.get(this.key(farmId, id)) : undefined;
    if (!current) throw new EntryNotFoundError(id);
    if (current.version !== expectedVersion) throw new ConcurrentModificationError(id);
    const updated: FarmRecord = { ...current, data: structuredClone(data), updatedAt: this.now().toISOString(), version: current.version + 1 };
    this.items.set(this.key(farmId, id), updated);
    return structuredClone(updated) as FarmRecord<T>;
  }

  async upsert<T extends Record<string, unknown>>(farmId: string, id: string, data: T, at: string) {
    const parsed = parseRecordId(id);
    if (!parsed) throw new Error(`Invalid record id ${id}`);
    const record: FarmRecord<T> = { id, kind: parsed.kind, farmId, data: structuredClone(data), createdAt: at, updatedAt: at, version: 1 };
    this.items.set(this.key(farmId, id), record as FarmRecord);
    return structuredClone(record);
  }

  async list<T extends Record<string, unknown>>(farmId: string, kind: RecordKind, query: RecordQuery = {}) {
    const { lo, hi } = sortKeyRange(kind, query);
    const found = [...this.items.values()]
      .filter((r) => r.farmId === farmId)
      .map((r) => ({ r, sk: parseRecordId(r.id)!.sortKey }))
      .filter(({ sk }) => sk >= lo && sk <= hi)
      .sort((a, b) => a.sk.localeCompare(b.sk))
      .map(({ r }) => structuredClone(r) as FarmRecord<T>);
    if (found.length > MAX_SUMMARY_ENTRIES) throw new TooManyEntriesError();
    return found;
  }
}
