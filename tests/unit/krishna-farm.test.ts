import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyImportPlan, checkKrishnaSeed, countPlan, KRISHNA_FARM_ID, normalizeDate, planKrishnaImport, type KrishnaSeed } from '../../src/demo/krishna-farm.js';
import { DEMO_NOTICE, VET_NOTICE } from '../../src/tools/farm-shared.js';
import { callTool, makeTestConfig, TEST_FARM_ID } from '../helpers/mcp-http.js';

const raw = JSON.parse(readFileSync(new URL('../../data/krishna-farm/krishna_farm_demo_seed.json', import.meta.url), 'utf8'));
const seed = checkKrishnaSeed(raw).seed as KrishnaSeed;
const clone = () => structuredClone(raw);

// The seed's own as-of date: 2026-10-21, 12:00 IST.
const AS_OF = new Date('2026-10-21T06:30:00Z');

async function seeded(now = AS_OF) {
  const setup = makeTestConfig(now);
  await applyImportPlan(planKrishnaImport(seed, TEST_FARM_ID), setup);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await callTool(setup.config, name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.content[0]!.text}`);
    return { text: r.content[0]!.text.split('\n')[0]!, data: r.structuredContent };
  };
  return { ...setup, call };
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

describe('Krishna Farm seed: validation', () => {
  it('accepts the seed file and reports its odd values as warnings', () => {
    const check = checkKrishnaSeed(raw);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([
      'animal COW-007 (Sita) is "milking" with 0 litres per day',
      'expense EXP-0068 is dated 2026-10-24, after 2026-10-21; it is left out of totals up to 2026-10-21',
      'expense EXP-0069 is dated 2026-10-27, after 2026-10-21; it is left out of totals up to 2026-10-21',
      'expense EXP-0076 is dated 2026-10-22, after 2026-10-21; it is left out of totals up to 2026-10-21',
      'expense EXP-0077 is dated 2026-10-25, after 2026-10-21; it is left out of totals up to 2026-10-21',
    ]);
  });

  it('refuses a field the mapping does not know, instead of dropping it', () => {
    const bad = clone();
    bad.animals[0].colour = 'brown';
    expect(checkKrishnaSeed(bad).errors.join()).toMatch(/animals\.0.*colour/);
  });

  it('refuses broken references, wrong totals, duplicate ids and impossible dates', () => {
    const bad = clone();
    bad.animals.find((a: any) => a.animal_id === 'CALF-001').mother_animal_id = 'COW-999';
    bad.expenses[0].amount_inr += 1;
    bad.milk_production_daily[0].total_litres += 1;
    bad.insurance_policies[1].policy_id = bad.insurance_policies[0].policy_id;
    bad.harvest_records[0].crop_record_id = 'CROP-999';
    bad.egg_production_daily[0].date = '2026-02-30';
    expect(checkKrishnaSeed(bad).errors).toEqual(
      expect.arrayContaining([
        'egg_production_daily.0.date: not a real calendar date (YYYY-MM-DD)',
      ]),
    );
    bad.egg_production_daily[0].date = '2026-09-01';
    const errors = checkKrishnaSeed(bad).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        'calf CALF-001 has no mother in the seed (mother_animal_id COW-999)',
        'expense EXP-0001: quantity × unit price is not the amount',
        'milk MILK-20261021-COW-001: morning + evening is not the total',
        'insurance_policies: id INS-001 appears twice',
        'harvest HAR-001: unknown crop CROP-999',
      ]),
    );
  });

  it('normalizes DD-MM-YYYY dates to ISO', () => {
    expect(normalizeDate('05-07-2026')).toBe('2026-07-05');
    expect(normalizeDate('2026-07-05')).toBe('2026-07-05');
    const dated = clone();
    dated.expenses[0].date = '05/05/2026';
    expect(checkKrishnaSeed(dated).seed!.expenses[0]!.date).toBe('2026-05-05');
  });
});

describe('Krishna Farm seed: mapping', () => {
  const plan = planKrishnaImport(seed);

  it('keeps every record on KRISHNA-FARM with stable ids, its seed id and the demo mark', () => {
    expect(plan.farmId).toBe(KRISHNA_FARM_ID);
    expect(countPlan(plan)).toEqual({ expense: 78, animal: 32, milk: 252, crop: 6, harvest: 4, insurance: 14, egg: 90, treatment: 4, vaccination: 4, feed: 4 });
    expect(plan.expenses.every((e) => e.farmId === KRISHNA_FARM_ID)).toBe(true);
    expect(plan.records.every((r) => r.data.demo === true && typeof r.data.sourceId === 'string')).toBe(true);
    const ids = [...plan.records.map((r) => r.id), ...plan.expenses.map((e) => e.entryId)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(planKrishnaImport(seed)).toEqual(plan); // same seed, same ids and data
  });

  it('links each calf to its mother by record id', () => {
    const animals = plan.records.filter((r) => r.kind === 'animal');
    const bySource = new Map(animals.map((a) => [a.data.sourceId, a]));
    const calves = seed.animals.filter((a) => a.animal_type === 'calf');
    expect(calves).toHaveLength(5);
    for (const calf of calves) {
      const record = bySource.get(calf.animal_id)!;
      const mother = bySource.get(calf.mother_animal_id!)!;
      expect(record.data.motherId).toBe(mother.id);
      expect(record.data.motherName).toBe(mother.data.name);
    }
  });

  it('keeps money in paise and the expense details in the note', () => {
    const first = plan.expenses[0]!;
    expect(first).toMatchObject({ date: '2026-05-05', category: 'feed', amountPaise: 1_327_000 });
    expect(first.note).toBe('Cattle concentrate feed: 10 bag × ₹1,327.00, Sri Lakshmi Cattle Feed, cash (demo EXP-0001)');
    expect(plan.expenses.reduce((n, e) => n + e.amountPaise, 0)).toBe(seed.expenses.reduce((n, e) => n + Math.round(e.amount_inr * 100), 0));
  });
});

describe('Krishna Farm seed: import', () => {
  it('re-importing rewrites the same items and never adds copies; other records are kept', async () => {
    const { ledger, records, call } = await seeded();
    await call('register_animal', { animals: [{ name: 'Nandini', type: 'cow' }] });
    const snapshot = async () => ({
      expenses: await ledger.getAllExpenses({ farmId: TEST_FARM_ID, from: '2000-01-01', to: '2099-12-31' }),
      animals: await records.list(TEST_FARM_ID, 'animal'),
      milk: await records.list(TEST_FARM_ID, 'milk'),
      eggs: await records.list(TEST_FARM_ID, 'egg'),
      harvests: await records.list(TEST_FARM_ID, 'harvest'),
      insurance: await records.list(TEST_FARM_ID, 'insurance'),
    });
    const before = await snapshot();
    await applyImportPlan(planKrishnaImport(seed, TEST_FARM_ID), { ledger, records });
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.animals).toHaveLength(33);
    expect(after.expenses).toHaveLength(78);
    expect(after.milk).toHaveLength(252);
  });
});

describe('Krishna Farm demo queries (as of 2026-10-21)', () => {
  it(seed.demo_queries[0]!.query, async () => {
    const { call } = await seeded();
    const { text, data } = await call('list_animals');
    expect(data.total).toBe(32);
    expect(data.byType).toEqual([
      { type: 'cow', count: 20 },
      { type: 'buffalo', count: 4 },
      { type: 'calf', count: 5 },
      { type: 'chicken', count: 3 },
    ]);
    expect(text).toMatch(/^32 active animals: 20 cows \(/);
    expect(data.animals.find((a: any) => a.name === 'Kamala')).toMatchObject({ motherName: 'Lakshmi', nameKn: 'ಕಮಲ', sourceId: 'CALF-001', demo: true });
  });

  it(seed.demo_queries[1]!.query, async () => {
    const { call } = await seeded();
    const { text, data } = await call('list_insurance', { status: 'overdue' });
    expect(data.policies.map((p: any) => [p.animalName, p.endDate, p.daysOverdue, p.premiumDisplay])).toEqual([
      ['Lakshmi', '2026-10-03', 18, '₹2,200.00'],
      ['Gangamma', '2026-10-10', 11, '₹1,950.00'],
      ['Durga', '2026-10-15', 6, '₹1,800.00'],
    ]);
    expect(data.counts).toEqual({ overdue: 3, due_soon: 4, active: 7 });
    expect(text).toContain('Lakshmi (New India Assurance, DEMO-KF-2026-0001) ended 2026-10-03, 18 days overdue, premium ₹2,200.00');
    expect(text).toContain(DEMO_NOTICE);
    // On this date the seed's own statuses agree with the dates.
    const all = (await call('list_insurance')).data.policies;
    expect(all.every((p: any) => p.status === p.demoStatus)).toBe(true);
  });

  it('insurance status follows the date, not the status stored in the seed', async () => {
    const { call } = await seeded(new Date('2026-11-05T06:30:00Z'));
    const { data } = await call('list_insurance', { animalName: 'Saraswati' });
    expect(data.policies[0]).toMatchObject({ endDate: '2026-10-26', status: 'overdue', daysOverdue: 10, demoStatus: 'due_soon' });
  });

  it(seed.demo_queries[2]!.query, async () => {
    const { text, data } = await call6Months();
    const upToAsOf = seed.expenses.filter((e) => e.date >= '2026-05-01' && e.date <= '2026-10-21');
    const totalPaise = upToAsOf.reduce((n, e) => n + Math.round(e.amount_inr * 100), 0);
    expect(totalPaise).toBe(35_315_800); // 4 seed expenses are dated after 2026-10-21 and stay out
    expect(data).toMatchObject({ range: { from: '2026-05-01', to: '2026-10-21', label: 'last_6_months' }, totalPaise, entryCount: 74 });
    expect(data.groups.map((g: any) => g.key)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    for (const g of data.groups) {
      const month = upToAsOf.filter((e) => e.date.startsWith(g.key));
      expect(g.totalPaise).toBe(month.reduce((n, e) => n + Math.round(e.amount_inr * 100), 0));
      expect(g.categories.reduce((n: number, c: any) => n + c.totalPaise, 0)).toBe(g.totalPaise);
    }
    expect(text).toMatch(/^Spent ₹3,53,158\.00 in total from 2026-05-01 to 2026-10-21 \(74 entries\)\. By month: 2026-05 ₹/);

    async function call6Months() {
      const { call } = await seeded();
      return call('get_expense_summary', { period: 'last_6_months', groupBy: 'month' });
    }
  });

  it('expenses by category over six months', async () => {
    const { data } = await (await seeded()).call('get_expense_summary', { period: 'last_6_months' });
    const expected = new Map<string, number>();
    for (const e of seed.expenses.filter((e) => e.date <= '2026-10-21')) expected.set(e.category, (expected.get(e.category) ?? 0) + Math.round(e.amount_inr * 100));
    expect(Object.fromEntries(data.groups.map((g: any) => [g.key, g.totalPaise]))).toEqual(Object.fromEntries(expected));
  });

  it(seed.demo_queries[3]!.query, async () => {
    const { text, data } = await (await seeded()).call('list_crops');
    const crop = (name: string) => data.crops.find((c: any) => c.crop === name);
    expect(crop('paddy')).toMatchObject({ harvestedGrams: 4_200_000, soldDisplay: '38 quintal (3,800 kg)', retainedDisplay: '4 quintal (400 kg)', revenueDisplay: '₹93,100.00', status: 'harvested' });
    expect(crop('ragi')).toMatchObject({ harvestedGrams: 1_050_000 });
    expect(crop('maize')).toMatchObject({ harvestedGrams: 5_100_000, revenueDisplay: '₹1,05,600.00', costDisplay: '₹42,500.00', netDisplay: '₹63,100.00' });
    expect(crop('papaya')).toMatchObject({ stage: 'ongoing_harvest', status: 'growing', harvestedGrams: 1_250_000, figuresToDate: true, harvestCount: 1 });
    expect(crop('banana')).toMatchObject({ stage: 'growing', harvestedGrams: 0, expectedHarvestWindow: '2026-11 to 2027-01' });
    expect(text).toContain('paddy in North Field sown 2026-06-18 (harvested, harvested 42 quintal (4,200 kg), sold 38 quintal (3,800 kg) for ₹93,100.00, kept 4 quintal (400 kg))');
    expect(text).toContain('42 quintal (4,200 kg)');
    expect(text).toContain('10.5 quintal (1,050 kg)');
    expect(text).toContain('51 quintal (5,100 kg)');
  });

  it(seed.demo_queries[4]!.query, async () => {
    const { call } = await seeded();
    const yesterday = await call('get_egg_summary', { period: 'yesterday' });
    expect(yesterday.data).toMatchObject({ range: { from: '2026-10-20', to: '2026-10-20' }, totalEggs: 0, latestRecordDate: '2026-09-30' });
    expect(yesterday.text).toBe('No eggs recorded on 2026-10-20. The latest egg record is from 2026-09-30.');

    const day = '2026-09-15';
    const oneDay = await call('get_egg_summary', { from: day, to: day });
    const expected = seed.egg_production_daily.filter((e) => e.date === day);
    expect(oneDay.data.totalEggs).toBe(expected.reduce((n, e) => n + e.eggs_collected, 0));
    expect(oneDay.data.days[0].byChicken).toEqual(expected.map((e) => ({ name: e.chicken_name, eggs: e.eggs_collected })).sort((a, b) => a.name.localeCompare(b.name)));

    const month = await call('get_egg_summary', { from: '2026-09-01', to: '2026-09-30' });
    expect(month.data.totalEggs).toBe(52);
    expect(month.data.days).toHaveLength(30);
    expect(month.data.byChicken.map((c: any) => c.name).sort()).toEqual(['Chinnu', 'Gauri', 'Kaveri']);

    const recent = await call('get_egg_summary');
    expect(recent.data.range).toEqual({ from: '2026-09-24', to: '2026-09-30', label: 'latest_7_days_with_records' });
  });

  it(seed.demo_queries[5]!.query, async () => {
    const { text, data } = await (await seeded()).call('get_health_records');
    expect(data.followUps.map((f: any) => [f.animalName, f.followUpDate, f.daysLeft])).toEqual([
      ['Chamundeshwari', '2026-10-22', 1],
      ['Gange', '2026-10-23', 2],
    ]);
    expect(data.vaccinationsDue.map((v: any) => [v.animalName, v.vaccine, v.nextDueDate, v.status])).toEqual([
      ['Lakshmi', 'FMD vaccination', '2026-10-10', 'overdue'],
      ['Gangamma', 'FMD vaccination', '2026-10-22', 'due_soon'],
    ]);
    expect(data.treatments).toHaveLength(4);
    expect(data.treatments[0]).toMatchObject({ date: '2026-10-16', animalName: 'Gange', medicineAsRecorded: 'Wound cleaning and dressing (demo)' });
    expect(data.notices).toEqual([DEMO_NOTICE, VET_NOTICE]);
    expect(text).toContain('Lakshmi FMD vaccination due 2026-10-10 (11 days overdue)');
    expect(text.endsWith(VET_NOTICE)).toBe(true);
    expect(text).not.toMatch(/antipyretic|dewormer/i); // medicines are in the records, never in the answer text
  });
});

describe('Krishna Farm dashboard reads', () => {
  it('feed stock flags items at or below the reorder level', async () => {
    const { text, data } = await (await seeded()).call('get_feed_stock');
    expect(data.reorderCount).toBe(3);
    expect(data.items.filter((i: any) => i.needsReorder).map((i: any) => i.item)).toEqual(['Dry fodder / hay', 'Green fodder', 'Mineral mixture']);
    expect(text).toContain('Dry fodder / hay (12 bundle left, reorder at 15 bundle)');
  });

  it('milk by animal and day over the last 7 days, filtered by date', async () => {
    const { call } = await seeded();
    const week = await call('get_milk_summary', { period: 'last_7_days', groupBy: 'animal_day' });
    const totalMl = seed.milk_production_daily.reduce((n, m) => n + Math.round(m.total_litres * 1000), 0);
    expect(week.data.totalMillilitres).toBe(totalMl);
    expect(week.data.animalDays).toHaveLength(18);
    for (const row of week.data.animalDays) expect(row.days).toHaveLength(7);
    const lakshmi = week.data.animalDays.find((r: any) => r.animalName === 'Lakshmi');
    expect(lakshmi.days.at(-1)).toEqual({ date: '2026-10-21', millilitres: 5500, display: '5.5 L' });

    const twoDays = await call('get_milk_summary', { from: '2026-10-20', to: '2026-10-21' });
    expect(twoDays.data.daysWithRecords).toBe(2);
    expect(twoDays.data.totalMillilitres).toBe(seed.milk_production_daily.filter((m) => m.date >= '2026-10-20').reduce((n, m) => n + Math.round(m.total_litres * 1000), 0));
  });

  it('an animal profile has its calves, milk, insurance and health records', async () => {
    const { text, data } = await (await seeded()).call('get_animal_profile', { animalName: 'Lakshmi' });
    expect(data.animal).toMatchObject({ name: 'Lakshmi', nameKn: 'ಲಕ್ಷ್ಮಿ', breed: 'Jersey cross', sourceId: 'COW-001', usualDailyDisplay: '5.5 L', purchaseValueDisplay: '₹52,000.00' });
    expect(data.calves.map((c: any) => c.name)).toEqual(['Kamala']);
    expect(data.milkLast7Days.days).toHaveLength(7);
    expect(data.insurance[0]).toMatchObject({ status: 'overdue', daysOverdue: 18 });
    expect(data.treatments.map((t: any) => t.status)).toEqual(['completed']);
    expect(data.vaccinations[0]).toMatchObject({ vaccine: 'FMD vaccination', status: 'overdue' });
    expect(text).toContain('Calves: Kamala.');
    expect(text).toContain(VET_NOTICE);
  });

  it('"Kaveri" is both a buffalo and a hen, so the name alone is refused rather than guessed', async () => {
    const { config } = await seeded();
    const r = await callTool(config, 'get_animal_profile', { animalName: 'Kaveri' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('2 animals are called "Kaveri"');
  });

  it('premiums and amounts are formatted in rupees by the server', () => {
    expect(rupees(35_315_800)).toBe('₹3,53,158.00');
  });
});
