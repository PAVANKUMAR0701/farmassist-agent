/**
 * Krishna Farm: a synthetic demo farm (data/krishna-farm/krishna_farm_demo_seed.json). This module checks the
 * seed file and maps it onto the existing records, without new tables:
 *   expenses                -> ledger expenses (EXP#)          animals            -> ANIMAL#
 *   milk_production_daily   -> MILK# (morning + evening)       crop_records       -> CROP#
 *   harvest_records         -> HARVEST#                        insurance_policies -> INSURANCE#
 *   egg_production_daily    -> EGG#                            animal_medical_records -> TREATMENT#
 *   vaccination_records     -> VACCINATION#                    feed_inventory     -> FEED#
 * Every seed id becomes a stable record id (src/domain/stable-id.ts), so importing twice rewrites the same
 * items instead of adding copies. The seed's own id is kept as `sourceId`, and every record is marked
 * `demo: true`. The field-by-field mapping is documented in docs/demo-data.md.
 */
import { z } from 'zod';
import { EXPENSE_CATEGORIES, type ExpenseCategory, type ExpenseEntry } from '../domain/expense.js';
import { stableUlid } from '../domain/stable-id.js';
import type { LedgerRepository } from '../repositories/ledger-repository.js';
import { recordIdWith, type RecordKind, type RecordStore } from '../repositories/record-store.js';
import { formatPaise } from '../shared/money.js';
import { acresToHundredths, litresToMillilitres, toGrams } from '../shared/quantity.js';
import { isValidIsoDate } from '../shared/time.js';

export const KRISHNA_FARM_ID = 'KRISHNA-FARM';

/** Accepts YYYY-MM-DD, or DD-MM-YYYY / DD/MM/YYYY, and returns YYYY-MM-DD. */
export function normalizeDate(value: string): string {
  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(value);
  return dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : value;
}

const date = z
  .string()
  .transform(normalizeDate)
  .refine(isValidIsoDate, 'not a real calendar date (YYYY-MM-DD)');
const text = z.string().trim().min(1);
const amount = z.number().nonnegative();

// Strict objects: a field the mapping does not know fails validation instead of being dropped silently.
const animalSchema = z.strictObject({
  animal_id: text,
  farm_id: text,
  name_en: text.optional(),
  name_kn: text.optional(),
  name: text.optional(),
  animal_type: z.enum(['cow', 'calf', 'buffalo', 'chicken']),
  breed: text.optional(),
  sex: z.enum(['female', 'male']).optional(),
  date_of_birth: date,
  mother_animal_id: text.optional(),
  lactation_status: text.optional(),
  daily_milk_litres: amount.optional(),
  health_status: text.optional(),
  purchase_value_inr: amount.optional(),
  milk_feeding: text.optional(),
  notes: text.optional(),
});

const insuranceSchema = z.strictObject({
  policy_id: text,
  farm_id: text,
  animal_id: text,
  animal_name: text,
  provider: text,
  policy_number: text,
  premium_inr: amount,
  expiry_date: date,
  status: z.enum(['overdue', 'due_soon', 'active']),
  reminder_days_before_expiry: z.number().int().nonnegative(),
  note: text.optional(),
});

const expenseSchema = z.strictObject({
  expense_id: text,
  farm_id: text,
  date,
  category: z.enum(EXPENSE_CATEGORIES),
  item: text,
  quantity: amount,
  unit: text,
  unit_price_inr: amount,
  amount_inr: z.number().positive(),
  vendor: text,
  payment_mode: text,
  notes: text.optional(),
});

const cropSchema = z.strictObject({
  crop_record_id: text,
  farm_id: text,
  crop: text,
  variety: text.optional(),
  plot_name: text,
  area_acres: z.number().positive(),
  sowing_date: date,
  transplanting_date: date.nullable(),
  harvest_date: date.nullable(),
  cultivation_status: z.enum(['growing', 'ongoing_harvest', 'harvested']),
  seed_quantity_kg: amount,
  fertilizer_cost_inr: amount,
  tractor_and_land_prep_cost_inr: amount,
  labour_cost_inr: amount,
  irrigation_cost_inr: amount,
  other_cost_inr: amount,
  total_cultivation_cost_inr: amount,
  // Harvested crops have final figures; a crop still being picked has figures "to date".
  yield_kg: amount.optional(),
  sale_quantity_kg: amount.optional(),
  retained_quantity_kg: amount.optional(),
  gross_revenue_inr: amount.optional(),
  net_revenue_before_overheads_inr: z.number().optional(),
  yield_kg_to_date: amount.optional(),
  sale_quantity_kg_to_date: amount.optional(),
  retained_quantity_kg_to_date: amount.optional(),
  gross_revenue_to_date_inr: amount.optional(),
  net_revenue_to_date_inr: z.number().optional(),
  sale_rate_inr_per_kg: amount.optional(),
  expected_harvest_window: text.optional(),
  notes: text.optional(),
});

const harvestSchema = z.strictObject({
  harvest_id: text,
  crop_record_id: text,
  crop: text,
  harvest_date: date,
  quantity_kg: z.number().positive(),
  quality_grade: text.optional(),
  sold_to: text.optional(),
  sale_date: date.optional(),
  quantity_sold_kg: amount,
  price_per_kg_inr: amount,
  total_sale_inr: amount,
  retained_kg: amount,
});

const eggSchema = z.strictObject({
  record_id: text,
  farm_id: text,
  date,
  chicken_id: text,
  chicken_name: text,
  eggs_collected: z.number().int().nonnegative(),
  eggs_damaged: z.number().int().nonnegative(),
  notes: text.optional(),
});

const treatmentSchema = z.strictObject({
  treatment_id: text,
  farm_id: text,
  animal_id: text,
  animal_name: text,
  date,
  symptoms: text,
  medicine: text,
  dose: text,
  route: text,
  duration_days: z.number().int().positive(),
  veterinarian: text,
  follow_up_date: date,
  status: text,
  withdrawal_period: text,
  warning: text.optional(),
});

const vaccinationSchema = z.strictObject({
  record_id: text,
  farm_id: text,
  animal_id: text,
  vaccine: text,
  date_given: date,
  next_due_date: date,
  status: text,
  notes: text.optional(),
});

const milkSchema = z.strictObject({
  record_id: text,
  farm_id: text,
  date,
  animal_id: text,
  animal_name: text,
  morning_litres: amount,
  evening_litres: amount,
  total_litres: amount,
  notes: text.optional(),
});

const feedSchema = z.strictObject({
  item_id: text,
  item: text,
  quantity: amount,
  unit: text,
  reorder_level: amount,
  last_updated: date,
  status: text.optional(),
});

export const krishnaSeedSchema = z.strictObject({
  metadata: z.object({ dataset_name: text, version: text, as_of_date: date, currency: z.literal('INR'), data_classification: text }).loose(),
  farm: z.strictObject({ farm_id: text, farm_name: text, owner_name: text, village: text, total_land_acres: z.number().positive(), timezone: z.literal('Asia/Kolkata'), as_of_date: date }),
  animals: z.array(animalSchema),
  insurance_policies: z.array(insuranceSchema),
  expenses: z.array(expenseSchema),
  crop_records: z.array(cropSchema),
  harvest_records: z.array(harvestSchema),
  egg_production_daily: z.array(eggSchema),
  animal_medical_records: z.array(treatmentSchema),
  vaccination_records: z.array(vaccinationSchema),
  milk_production_daily: z.array(milkSchema),
  feed_inventory: z.array(feedSchema),
  demo_queries: z.array(z.strictObject({ query: text, expected: text })),
});

export type KrishnaSeed = z.infer<typeof krishnaSeedSchema>;

export interface SeedCheck {
  seed?: KrishnaSeed;
  /** Problems that stop the import. */
  errors: string[];
  /** Odd but importable values, reported so they can be fixed in the seed. */
  warnings: string[];
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * Validates a parsed seed file: shape and dates, unique ids, one farm, every animal and crop reference,
 * the calf-to-mother links, and the totals the file states (amount = quantity × price, cost and revenue sums).
 */
export function checkKrishnaSeed(raw: unknown): SeedCheck {
  const parsed = krishnaSeedSchema.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), warnings: [] };
  const seed = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const farmId = seed.farm.farm_id;
  const asOf = seed.farm.as_of_date;

  const unique = (name: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`${name}: id ${id} appears twice`);
      seen.add(id);
    }
  };
  unique('animals', seed.animals.map((a) => a.animal_id));
  unique('insurance_policies', seed.insurance_policies.map((p) => p.policy_id));
  unique('expenses', seed.expenses.map((e) => e.expense_id));
  unique('crop_records', seed.crop_records.map((c) => c.crop_record_id));
  unique('harvest_records', seed.harvest_records.map((h) => h.harvest_id));
  unique('egg_production_daily', seed.egg_production_daily.map((e) => e.record_id));
  unique('animal_medical_records', seed.animal_medical_records.map((t) => t.treatment_id));
  unique('vaccination_records', seed.vaccination_records.map((v) => v.record_id));
  unique('milk_production_daily', seed.milk_production_daily.map((m) => m.record_id));
  unique('feed_inventory', seed.feed_inventory.map((f) => f.item_id));

  const withFarm: Array<[string, Array<{ farm_id: string }>]> = [
    ['animals', seed.animals],
    ['insurance_policies', seed.insurance_policies],
    ['expenses', seed.expenses],
    ['crop_records', seed.crop_records],
    ['egg_production_daily', seed.egg_production_daily],
    ['animal_medical_records', seed.animal_medical_records],
    ['vaccination_records', seed.vaccination_records],
    ['milk_production_daily', seed.milk_production_daily],
  ];
  for (const [name, rows] of withFarm) if (rows.some((r) => r.farm_id !== farmId)) errors.push(`${name}: a record belongs to another farm than ${farmId}`);

  const animals = new Map(seed.animals.map((a) => [a.animal_id, a]));
  const nameOf = (a: (typeof seed.animals)[number]) => a.name_en ?? a.name;
  for (const a of seed.animals) {
    if (!nameOf(a)) errors.push(`animal ${a.animal_id} has no name`);
    if (a.date_of_birth > asOf) errors.push(`animal ${a.animal_id} is born after ${asOf}`);
    if (a.animal_type === 'calf') {
      const mother = a.mother_animal_id ? animals.get(a.mother_animal_id) : undefined;
      if (!mother) errors.push(`calf ${a.animal_id} has no mother in the seed (mother_animal_id ${a.mother_animal_id ?? 'missing'})`);
      else if (mother.sex !== 'female' || mother.date_of_birth >= a.date_of_birth) errors.push(`calf ${a.animal_id}: ${mother.animal_id} cannot be its mother`);
    } else if (a.mother_animal_id && !animals.has(a.mother_animal_id)) errors.push(`animal ${a.animal_id}: unknown mother ${a.mother_animal_id}`);
    if (a.lactation_status === 'milking' && a.daily_milk_litres === 0) warnings.push(`animal ${a.animal_id} (${nameOf(a)}) is "milking" with 0 litres per day`);
  }
  const refersTo = (where: string, animalId: string, name?: string, type?: string) => {
    const animal = animals.get(animalId);
    if (!animal) return errors.push(`${where}: unknown animal ${animalId}`);
    if (name && nameOf(animal) !== name) errors.push(`${where}: animal ${animalId} is ${nameOf(animal)}, not ${name}`);
    if (type && animal.animal_type !== type) errors.push(`${where}: animal ${animalId} is a ${animal.animal_type}, not a ${type}`);
  };
  for (const p of seed.insurance_policies) refersTo(`insurance ${p.policy_id}`, p.animal_id, p.animal_name);
  for (const t of seed.animal_medical_records) {
    refersTo(`treatment ${t.treatment_id}`, t.animal_id, t.animal_name);
    if (t.date > asOf) errors.push(`treatment ${t.treatment_id} is dated after ${asOf}`);
    if (t.follow_up_date < t.date) errors.push(`treatment ${t.treatment_id}: follow-up before the treatment`);
  }
  for (const v of seed.vaccination_records) {
    refersTo(`vaccination ${v.record_id}`, v.animal_id);
    if (v.next_due_date <= v.date_given) errors.push(`vaccination ${v.record_id}: next due date is not after the date given`);
  }
  for (const e of seed.egg_production_daily) {
    refersTo(`eggs ${e.record_id}`, e.chicken_id, e.chicken_name, 'chicken');
    if (e.date > asOf) errors.push(`eggs ${e.record_id} are dated after ${asOf}`);
    if (e.eggs_damaged > e.eggs_collected) errors.push(`eggs ${e.record_id}: more damaged than collected`);
  }
  const milkKey = new Set<string>();
  for (const m of seed.milk_production_daily) {
    refersTo(`milk ${m.record_id}`, m.animal_id, m.animal_name);
    if (!['cow', 'buffalo'].includes(animals.get(m.animal_id)?.animal_type ?? 'cow')) errors.push(`milk ${m.record_id}: ${m.animal_id} is not a cow or buffalo`);
    if (m.date > asOf) errors.push(`milk ${m.record_id} is dated after ${asOf}`);
    if (!near(m.morning_litres + m.evening_litres, m.total_litres)) errors.push(`milk ${m.record_id}: morning + evening is not the total`);
    if (milkKey.has(`${m.date}|${m.animal_id}`)) errors.push(`milk ${m.record_id}: a second log for ${m.animal_id} on ${m.date}`);
    milkKey.add(`${m.date}|${m.animal_id}`);
  }
  for (const e of seed.expenses) {
    // Kept: totals "up to today" leave it out by date, which is what the demo queries expect.
    if (e.date > asOf) warnings.push(`expense ${e.expense_id} is dated ${e.date}, after ${asOf}; it is left out of totals up to ${asOf}`);
    if (!near(e.quantity * e.unit_price_inr, e.amount_inr)) errors.push(`expense ${e.expense_id}: quantity × unit price is not the amount`);
  }
  const crops = new Map(seed.crop_records.map((c) => [c.crop_record_id, c]));
  for (const c of seed.crop_records) {
    const parts = c.fertilizer_cost_inr + c.tractor_and_land_prep_cost_inr + c.labour_cost_inr + c.irrigation_cost_inr + c.other_cost_inr;
    if (!near(parts, c.total_cultivation_cost_inr)) errors.push(`crop ${c.crop_record_id}: cost parts do not add up to the total`);
    const f = cropFigures(c);
    if (f) {
      if (!near(f.sold + f.retained, f.yield)) errors.push(`crop ${c.crop_record_id}: sold + retained is not the yield`);
      if (c.sale_rate_inr_per_kg !== undefined && !near(f.sold * c.sale_rate_inr_per_kg, f.gross)) errors.push(`crop ${c.crop_record_id}: sold × rate is not the revenue`);
      if (f.net !== undefined && !near(f.gross - c.total_cultivation_cost_inr, f.net)) errors.push(`crop ${c.crop_record_id}: revenue − cost is not the net`);
    }
    if (c.cultivation_status === 'harvested' && !c.harvest_date) errors.push(`crop ${c.crop_record_id} is harvested but has no harvest date`);
  }
  for (const h of seed.harvest_records) {
    const crop = crops.get(h.crop_record_id);
    if (!crop) {
      errors.push(`harvest ${h.harvest_id}: unknown crop ${h.crop_record_id}`);
      continue;
    }
    if (crop.crop !== h.crop) errors.push(`harvest ${h.harvest_id}: crop ${h.crop_record_id} is ${crop.crop}, not ${h.crop}`);
    if (h.harvest_date < crop.sowing_date || h.harvest_date > asOf) errors.push(`harvest ${h.harvest_id}: date outside the crop's season`);
    if (!near(h.quantity_sold_kg + h.retained_kg, h.quantity_kg)) errors.push(`harvest ${h.harvest_id}: sold + retained is not the quantity`);
    if (!near(h.quantity_sold_kg * h.price_per_kg_inr, h.total_sale_inr)) errors.push(`harvest ${h.harvest_id}: sold × price is not the sale total`);
  }
  for (const f of seed.feed_inventory) if (f.last_updated > asOf) errors.push(`feed ${f.item_id} is updated after ${asOf}`);
  return errors.length ? { errors, warnings } : { seed, errors, warnings };
}

/** A crop's harvest and sale figures: final for a harvested crop, "to date" for one still being picked. */
function cropFigures(c: KrishnaSeed['crop_records'][number]) {
  const yieldKg = c.yield_kg ?? c.yield_kg_to_date;
  if (yieldKg === undefined) return undefined;
  return {
    yield: yieldKg,
    sold: c.sale_quantity_kg ?? c.sale_quantity_kg_to_date ?? 0,
    retained: c.retained_quantity_kg ?? c.retained_quantity_kg_to_date ?? 0,
    gross: c.gross_revenue_inr ?? c.gross_revenue_to_date_inr ?? 0,
    net: c.net_revenue_before_overheads_inr ?? c.net_revenue_to_date_inr,
    toDate: c.yield_kg === undefined,
  };
}

const paise = (rupees: number) => Math.round(rupees * 100);
/** Copies only the fields that have a value (records never store undefined). */
const defined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

export interface SeedRecord {
  kind: RecordKind;
  id: string;
  data: Record<string, unknown>;
}

export interface ImportPlan {
  farmId: string;
  /** Timestamp written on every imported item: the seed's as-of date, so a re-import writes identical items. */
  at: string;
  records: SeedRecord[];
  expenses: ExpenseEntry[];
}

/**
 * Maps a checked seed onto FarmAssist records for `farmId` (default: the seed's own farm id). Pure: the same
 * seed always gives the same ids and data.
 */
export function planKrishnaImport(seed: KrishnaSeed, farmId: string = seed.farm.farm_id): ImportPlan {
  const at = `${seed.farm.as_of_date}T00:00:00.000Z`;
  const key = (collection: string, id: string) => `${seed.farm.farm_id}/${collection}/${id}`;
  const records: SeedRecord[] = [];
  const add = (kind: RecordKind, id: string, data: Record<string, unknown>) => records.push({ kind, id, data: defined({ ...data, demo: true }) });

  const animalIds = new Map<string, string>();
  for (const a of seed.animals) animalIds.set(a.animal_id, recordIdWith('animal', stableUlid(key('animals', a.animal_id), a.date_of_birth)));
  const byId = new Map(seed.animals.map((a) => [a.animal_id, a]));
  const nameOf = (id: string) => {
    const a = byId.get(id)!;
    return a.name_en ?? a.name!;
  };
  for (const a of seed.animals) {
    add('animal', animalIds.get(a.animal_id)!, {
      name: a.name_en ?? a.name,
      nameKn: a.name_kn,
      type: a.animal_type,
      breed: a.breed,
      sex: a.sex,
      birthDate: a.date_of_birth,
      motherId: a.mother_animal_id && animalIds.get(a.mother_animal_id),
      motherName: a.mother_animal_id && nameOf(a.mother_animal_id),
      status: 'active',
      lactationStatus: a.lactation_status,
      healthStatus: a.health_status,
      usualDailyMillilitres: a.daily_milk_litres === undefined ? undefined : litresToMillilitres(a.daily_milk_litres),
      purchaseValuePaise: a.purchase_value_inr === undefined ? undefined : paise(a.purchase_value_inr),
      milkFeeding: a.milk_feeding,
      notes: a.notes,
      sourceId: a.animal_id,
    });
  }

  for (const m of seed.milk_production_daily) {
    for (const session of ['morning', 'evening'] as const) {
      const litres = session === 'morning' ? m.morning_litres : m.evening_litres;
      add('milk', recordIdWith('milk', stableUlid(key('milk', `${m.record_id}/${session}`), m.date), { date: m.date }), {
        date: m.date,
        millilitres: litresToMillilitres(litres),
        session,
        animalId: animalIds.get(m.animal_id),
        animalName: m.animal_name,
        note: m.notes,
        sourceId: m.record_id,
      });
    }
  }

  const cropIds = new Map<string, string>();
  for (const c of seed.crop_records) {
    const id = recordIdWith('crop', stableUlid(key('crops', c.crop_record_id), c.sowing_date));
    cropIds.set(c.crop_record_id, id);
    const f = cropFigures(c);
    add('crop', id, {
      crop: c.crop.trim().toLowerCase(),
      variety: c.variety,
      field: c.plot_name,
      areaHundredths: acresToHundredths(c.area_acres),
      sownDate: c.sowing_date,
      seedGrams: c.seed_quantity_kg > 0 ? toGrams(c.seed_quantity_kg, 'kg') : undefined,
      status: c.cultivation_status === 'harvested' ? 'harvested' : 'growing',
      harvestedDate: c.cultivation_status === 'harvested' ? c.harvest_date : undefined,
      stage: c.cultivation_status,
      transplantedDate: c.transplanting_date,
      expectedHarvestWindow: c.expected_harvest_window,
      costPaise: {
        fertilizer: paise(c.fertilizer_cost_inr),
        tractorAndLandPrep: paise(c.tractor_and_land_prep_cost_inr),
        labour: paise(c.labour_cost_inr),
        irrigation: paise(c.irrigation_cost_inr),
        other: paise(c.other_cost_inr),
      },
      totalCostPaise: paise(c.total_cultivation_cost_inr),
      ...(f
        ? {
            reportedYieldGrams: toGrams(f.yield, 'kg'),
            soldGrams: toGrams(f.sold, 'kg'),
            retainedGrams: toGrams(f.retained, 'kg'),
            grossRevenuePaise: paise(f.gross),
            netRevenuePaise: f.net === undefined ? undefined : paise(f.net),
            figuresToDate: f.toDate || undefined,
          }
        : {}),
      saleRatePaisePerKg: c.sale_rate_inr_per_kg === undefined ? undefined : paise(c.sale_rate_inr_per_kg),
      notes: c.notes,
      sourceId: c.crop_record_id,
    });
  }
  for (const h of seed.harvest_records) {
    const cropId = cropIds.get(h.crop_record_id)!;
    add('harvest', recordIdWith('harvest', stableUlid(key('harvests', h.harvest_id), h.harvest_date), { cropId }), {
      cropId,
      date: h.harvest_date,
      grams: toGrams(h.quantity_kg, 'kg'),
      soldGrams: toGrams(h.quantity_sold_kg, 'kg'),
      retainedGrams: toGrams(h.retained_kg, 'kg'),
      salePaise: paise(h.total_sale_inr),
      pricePaisePerKg: paise(h.price_per_kg_inr),
      saleDate: h.sale_date,
      soldTo: h.sold_to,
      qualityGrade: h.quality_grade,
      sourceId: h.harvest_id,
    });
  }

  for (const p of seed.insurance_policies) {
    add('insurance', recordIdWith('insurance', stableUlid(key('insurance', p.policy_id), p.expiry_date)), {
      animalId: animalIds.get(p.animal_id),
      animalName: p.animal_name,
      insurer: p.provider,
      policyNumber: p.policy_number,
      endDate: p.expiry_date,
      premiumPaise: paise(p.premium_inr),
      demoStatus: p.status,
      reminderDaysBeforeExpiry: p.reminder_days_before_expiry,
      notes: p.note,
      sourceId: p.policy_id,
    });
  }

  for (const e of seed.egg_production_daily) {
    add('egg', recordIdWith('egg', stableUlid(key('eggs', e.record_id), e.date), { date: e.date }), {
      date: e.date,
      chickenId: animalIds.get(e.chicken_id),
      chickenName: e.chicken_name,
      eggsCollected: e.eggs_collected,
      eggsDamaged: e.eggs_damaged,
      note: e.notes,
      sourceId: e.record_id,
    });
  }

  for (const t of seed.animal_medical_records) {
    add('treatment', recordIdWith('treatment', stableUlid(key('treatments', t.treatment_id), t.date), { date: t.date }), {
      date: t.date,
      animalId: animalIds.get(t.animal_id),
      animalName: t.animal_name,
      symptoms: t.symptoms,
      medicine: t.medicine,
      dose: t.dose,
      route: t.route,
      durationDays: t.duration_days,
      veterinarian: t.veterinarian,
      followUpDate: t.follow_up_date,
      status: t.status,
      withdrawalPeriod: t.withdrawal_period,
      warning: t.warning,
      sourceId: t.treatment_id,
    });
  }

  for (const v of seed.vaccination_records) {
    add('vaccination', recordIdWith('vaccination', stableUlid(key('vaccinations', v.record_id), v.date_given)), {
      animalId: animalIds.get(v.animal_id),
      animalName: nameOf(v.animal_id),
      vaccine: v.vaccine,
      dateGiven: v.date_given,
      nextDueDate: v.next_due_date,
      demoStatus: v.status,
      notes: v.notes,
      sourceId: v.record_id,
    });
  }

  for (const f of seed.feed_inventory) {
    add('feed', recordIdWith('feed', stableUlid(key('feed', f.item_id), f.last_updated)), {
      item: f.item,
      quantity: f.quantity,
      unit: f.unit,
      reorderLevel: f.reorder_level,
      lastUpdated: f.last_updated,
      demoStatus: f.status,
      sourceId: f.item_id,
    });
  }

  // The ledger has no columns for item, quantity, vendor or payment mode: they go into the note, word for word.
  const expenses: ExpenseEntry[] = seed.expenses.map((e) => ({
    entryId: `exp_${e.date.replaceAll('-', '')}_${stableUlid(key('expenses', e.expense_id), e.date)}`,
    farmId,
    date: e.date,
    category: e.category as ExpenseCategory,
    amountPaise: paise(e.amount_inr),
    note: `${e.item}: ${e.quantity} ${e.unit} × ${formatPaise(paise(e.unit_price_inr))}, ${e.vendor}, ${e.payment_mode} (demo ${e.expense_id})`,
    createdAt: at,
    updatedAt: at,
    version: 1,
  }));

  return { farmId, at, records, expenses };
}

/** How many items of each kind an import plan writes. */
export function countPlan(plan: ImportPlan): Record<string, number> {
  const counts: Record<string, number> = { expense: plan.expenses.length };
  for (const r of plan.records) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  return counts;
}

/**
 * Writes an import plan with upserts (same ids every time), a few writes at a time. Re-running it leaves
 * exactly the same items; the farm's other records are not touched.
 */
export async function applyImportPlan(plan: ImportPlan, stores: { records: RecordStore; ledger: LedgerRepository }, concurrency = 8): Promise<number> {
  const writes: Array<() => Promise<unknown>> = [
    ...plan.records.map((r) => () => stores.records.upsert(plan.farmId, r.id, r.data, plan.at)),
    ...plan.expenses.map((e) => () => stores.ledger.upsertExpense(e)),
  ];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, writes.length) }, async () => {
      while (next < writes.length) await writes[next++]!();
    }),
  );
  return writes.length;
}
