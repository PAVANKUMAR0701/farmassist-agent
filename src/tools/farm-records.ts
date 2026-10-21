/**
 * Read-only views over the herd's other records: list_insurance, get_egg_summary, get_health_records,
 * get_feed_stock and get_animal_profile. Every status, count and total is worked out here from dates and
 * stored values; statuses stored with imported demo data are shown, never trusted.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import type { FarmRecord } from '../repositories/record-store.js';
import { formatPaise } from '../shared/money.js';
import { formatLitres } from '../shared/quantity.js';
import { addDays, daysBetween, todayInFarmTimeZone } from '../shared/time.js';
import { animalViewSchema, toAnimalView } from './animals.js';
import {
  ageDisplay,
  animalRefInput,
  DEMO_NOTICE,
  INSURANCE_DUE_SOON_DAYS,
  insuranceStatus,
  plural,
  resolveAnimal,
  VET_NOTICE,
  type AnimalData,
  type InsuranceStatus,
} from './farm-shared.js';
import { dateRangeInput, resolveDateRange, type ToolDeps } from './shared.js';
import { runTool } from './tool-errors.js';

interface InsuranceData extends Record<string, unknown> {
  animalId: string;
  animalName?: string;
  insurer: string;
  policyNumber?: string;
  endDate: string;
  premiumPaise?: number;
  demoStatus?: string;
  demo?: boolean;
}

interface EggData extends Record<string, unknown> {
  date: string;
  chickenId?: string;
  chickenName: string;
  eggsCollected: number;
  eggsDamaged: number;
  demo?: boolean;
}

interface TreatmentData extends Record<string, unknown> {
  date: string;
  animalId: string;
  animalName?: string;
  symptoms: string;
  medicine?: string;
  dose?: string;
  route?: string;
  durationDays?: number;
  veterinarian?: string;
  followUpDate?: string;
  status: string;
  withdrawalPeriod?: string;
  demo?: boolean;
}

interface VaccinationData extends Record<string, unknown> {
  animalId: string;
  animalName?: string;
  vaccine: string;
  dateGiven: string;
  nextDueDate: string;
  demoStatus?: string;
  demo?: boolean;
}

interface FeedData extends Record<string, unknown> {
  item: string;
  quantity: number;
  unit: string;
  reorderLevel: number;
  lastUpdated: string;
  demo?: boolean;
}

interface MilkData extends Record<string, unknown> {
  date: string;
  millilitres: number;
  animalId?: string;
}

const respond = (text: string, structured: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }],
  structuredContent: structured,
});
const dueText = (days: number) => (days < 0 ? `${plural(-days, 'day')} overdue` : days === 0 ? 'due today' : `in ${plural(days, 'day')}`);
const anyDemo = (...lists: Array<Array<FarmRecord<{ demo?: boolean }>>>) => lists.some((l) => l.some((r) => r.data.demo));

// ---------- insurance ----------

const policySchema = z.object({
  insuranceId: z.string(),
  animalId: z.string(),
  animalName: z.string().optional(),
  insurer: z.string(),
  policyNumber: z.string().optional(),
  endDate: z.string(),
  status: z.enum(['overdue', 'due_soon', 'active']).describe('Worked out from endDate and today; this is the current status.'),
  daysLeft: z.number().int().describe('Days until the end date; negative once it has passed.'),
  daysOverdue: z.number().int().optional(),
  premiumPaise: z.number().int().optional(),
  premiumDisplay: z.string().optional(),
  demoStatus: z.string().optional().describe('Status written in the imported demo data on its own date; shown for reference only.'),
  demo: z.boolean().optional(),
});

function policyView(p: FarmRecord<InsuranceData>, today: string): z.infer<typeof policySchema> {
  const { status, daysLeft } = insuranceStatus(p.data.endDate, today);
  return {
    insuranceId: p.id,
    animalId: p.data.animalId,
    ...(p.data.animalName ? { animalName: p.data.animalName } : {}),
    insurer: p.data.insurer,
    ...(p.data.policyNumber ? { policyNumber: p.data.policyNumber } : {}),
    endDate: p.data.endDate,
    status,
    daysLeft,
    ...(daysLeft < 0 ? { daysOverdue: -daysLeft } : {}),
    ...(p.data.premiumPaise !== undefined ? { premiumPaise: p.data.premiumPaise, premiumDisplay: formatPaise(p.data.premiumPaise) } : {}),
    ...(p.data.demoStatus ? { demoStatus: p.data.demoStatus } : {}),
    ...(p.data.demo ? { demo: true } : {}),
  };
}

const STATUS_ORDER: Record<InsuranceStatus, number> = { overdue: 0, due_soon: 1, active: 2 };

// ---------- vaccinations ----------

const vaccinationSchema = z.object({
  vaccinationId: z.string(),
  animalId: z.string(),
  animalName: z.string().optional(),
  vaccine: z.string(),
  dateGiven: z.string(),
  nextDueDate: z.string(),
  status: z.enum(['overdue', 'due_soon', 'upcoming']).describe('Worked out from nextDueDate and today.'),
  daysLeft: z.number().int(),
  demoStatus: z.string().optional(),
  demo: z.boolean().optional(),
});

function vaccinationView(v: FarmRecord<VaccinationData>, today: string): z.infer<typeof vaccinationSchema> {
  const daysLeft = daysBetween(today, v.data.nextDueDate);
  return {
    vaccinationId: v.id,
    animalId: v.data.animalId,
    ...(v.data.animalName ? { animalName: v.data.animalName } : {}),
    vaccine: v.data.vaccine,
    dateGiven: v.data.dateGiven,
    nextDueDate: v.data.nextDueDate,
    status: daysLeft < 0 ? 'overdue' : daysLeft <= INSURANCE_DUE_SOON_DAYS ? 'due_soon' : 'upcoming',
    daysLeft,
    ...(v.data.demoStatus ? { demoStatus: v.data.demoStatus } : {}),
    ...(v.data.demo ? { demo: true } : {}),
  };
}

// ---------- treatments ----------

const treatmentSchema = z.object({
  treatmentId: z.string(),
  date: z.string(),
  animalId: z.string(),
  animalName: z.string().optional(),
  symptoms: z.string(),
  medicineAsRecorded: z.string().optional().describe('As written in the record. Not advice: a veterinarian decides medicine and dose.'),
  doseAsRecorded: z.string().optional(),
  route: z.string().optional(),
  durationDays: z.number().int().optional(),
  veterinarian: z.string().optional(),
  followUpDate: z.string().optional(),
  followUpDaysLeft: z.number().int().optional(),
  status: z.string(),
  withdrawalPeriodAsRecorded: z.string().optional(),
  demo: z.boolean().optional(),
});

function treatmentView(t: FarmRecord<TreatmentData>, today: string): z.infer<typeof treatmentSchema> {
  const d = t.data;
  return {
    treatmentId: t.id,
    date: d.date,
    animalId: d.animalId,
    ...(d.animalName ? { animalName: d.animalName } : {}),
    symptoms: d.symptoms,
    ...(d.medicine ? { medicineAsRecorded: d.medicine } : {}),
    ...(d.dose ? { doseAsRecorded: d.dose } : {}),
    ...(d.route ? { route: d.route } : {}),
    ...(d.durationDays ? { durationDays: d.durationDays } : {}),
    ...(d.veterinarian ? { veterinarian: d.veterinarian } : {}),
    ...(d.followUpDate ? { followUpDate: d.followUpDate, followUpDaysLeft: daysBetween(today, d.followUpDate) } : {}),
    status: d.status,
    ...(d.withdrawalPeriod ? { withdrawalPeriodAsRecorded: d.withdrawalPeriod } : {}),
    ...(d.demo ? { demo: true } : {}),
  };
}

const notices = (demo: boolean, health: boolean) => [...(demo ? [DEMO_NOTICE] : []), ...(health ? [VET_NOTICE] : [])];

export function registerFarmRecordTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_insurance',
    {
      title: 'Animal insurance',
      description:
        'Lists animal insurance policies with their current status worked out from the end date: overdue (ended), due soon (ends within 30 days) or active, ' +
        'with days overdue and the premium. Use it for "which insurance is overdue", "whose insurance ends soon", "insurance premium for Lakshmi".',
      inputSchema: {
        status: z.enum(['overdue', 'due_soon', 'active', 'needs_renewal', 'all']).default('all').describe('"needs_renewal" = overdue and due soon together.'),
        ...animalRefInput,
      },
      outputSchema: {
        asOf: z.string(),
        policies: z.array(policySchema),
        counts: z.object({ overdue: z.number().int(), due_soon: z.number().int(), active: z.number().int() }),
        premiumTotalPaise: z.number().int().describe('Sum of the premiums of the listed policies.'),
        premiumTotalDisplay: z.string(),
        notices: z.array(z.string()),
        calculatedBy: z.literal('server'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('list_insurance', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const animal = args.animalId || args.animalName ? await resolveAnimal(deps.records, farmId, args, { includeInactive: true }) : undefined;
        const all = (await deps.records.list<InsuranceData>(farmId, 'insurance')).filter((p) => !animal || p.data.animalId === animal.id);
        const views = all.map((p) => policyView(p, today));
        const counts = { overdue: 0, due_soon: 0, active: 0 };
        for (const v of views) counts[v.status]++;
        const policies = views
          .filter((v) => args.status === 'all' || v.status === args.status || (args.status === 'needs_renewal' && v.status !== 'active'))
          .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.endDate.localeCompare(b.endDate));
        const premiumTotalPaise = policies.reduce((sum, p) => sum + (p.premiumPaise ?? 0), 0);
        const what = args.status === 'all' ? '' : `${args.status.replace('_', ' ')} `;
        const line = (p: z.infer<typeof policySchema>) =>
          `${p.animalName ?? 'animal'} (${p.insurer}${p.policyNumber ? `, ${p.policyNumber}` : ''}) ${p.status === 'overdue' ? `ended ${p.endDate}, ${dueText(p.daysLeft)}` : `ends ${p.endDate}, ${dueText(p.daysLeft)}`}${p.premiumDisplay ? `, premium ${p.premiumDisplay}` : ''}`;
        const text =
          policies.length === 0
            ? `No ${what}insurance policies${animal?.data.name ? ` for ${animal.data.name}` : ''} as of ${today}.`
            : `${plural(policies.length, `${what}policy`, `${what}policies`)} as of ${today}: ${policies.slice(0, 12).map(line).join('; ')}${policies.length > 12 ? '; …' : ''}. ` +
              `Premiums of these: ${formatPaise(premiumTotalPaise)}. All policies: ${counts.overdue} overdue, ${counts.due_soon} due soon, ${counts.active} active.`;
        const structured = { asOf: today, policies, counts, premiumTotalPaise, premiumTotalDisplay: formatPaise(premiumTotalPaise), notices: notices(anyDemo(all), false), calculatedBy: 'server' as const };
        return respond(`${text}${anyDemo(all) ? ` ${DEMO_NOTICE}` : ''}`, structured);
      }),
  );

  server.registerTool(
    'get_egg_summary',
    {
      title: 'Egg production',
      description:
        'Eggs collected per chicken per day and the total per day, counted by FarmAssist. Use it for "how many eggs yesterday", "eggs this month", "which hen lays most". ' +
        'With no period it covers the 7 most recent days that have egg records.',
      inputSchema: { ...dateRangeInput },
      outputSchema: {
        range: z.object({ from: z.string(), to: z.string(), label: z.string() }),
        totalEggs: z.number().int(),
        damagedEggs: z.number().int(),
        days: z.array(z.object({ date: z.string(), eggs: z.number().int(), damaged: z.number().int(), byChicken: z.array(z.object({ name: z.string(), eggs: z.number().int() })) })),
        byChicken: z.array(z.object({ name: z.string(), eggs: z.number().int(), damaged: z.number().int(), daysRecorded: z.number().int() })),
        latestRecordDate: z.string().optional().describe('The most recent day with any egg record.'),
        notices: z.array(z.string()),
        calculatedBy: z.literal('server'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('get_egg_summary', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const latest = (await deps.records.list<EggData>(farmId, 'egg', { to: today })).at(-1)?.data.date;
        const explicit = args.period || args.from || args.to;
        const range = explicit ? resolveDateRange(args, today) : latest ? { from: addDays(latest, -6), to: latest, label: 'latest_7_days_with_records' } : { from: addDays(today, -6), to: today, label: 'last_7_days' };
        const entries = await deps.records.list<EggData>(farmId, 'egg', { from: range.from, to: range.to });
        const days = new Map<string, { eggs: number; damaged: number; byChicken: Map<string, number> }>();
        const hens = new Map<string, { eggs: number; damaged: number; days: Set<string> }>();
        for (const e of entries) {
          const day = days.get(e.data.date) ?? { eggs: 0, damaged: 0, byChicken: new Map() };
          day.eggs += e.data.eggsCollected;
          day.damaged += e.data.eggsDamaged;
          day.byChicken.set(e.data.chickenName, (day.byChicken.get(e.data.chickenName) ?? 0) + e.data.eggsCollected);
          days.set(e.data.date, day);
          const hen = hens.get(e.data.chickenName) ?? { eggs: 0, damaged: 0, days: new Set() };
          hen.eggs += e.data.eggsCollected;
          hen.damaged += e.data.eggsDamaged;
          hen.days.add(e.data.date);
          hens.set(e.data.chickenName, hen);
        }
        const dayList = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => ({ date, eggs: d.eggs, damaged: d.damaged, byChicken: [...d.byChicken].sort(([a], [b]) => a.localeCompare(b)).map(([name, eggs]) => ({ name, eggs })) }));
        const byChicken = [...hens.entries()].map(([name, h]) => ({ name, eggs: h.eggs, damaged: h.damaged, daysRecorded: h.days.size })).sort((a, b) => b.eggs - a.eggs || a.name.localeCompare(b.name));
        const totalEggs = dayList.reduce((n, d) => n + d.eggs, 0);
        const damagedEggs = dayList.reduce((n, d) => n + d.damaged, 0);
        const when = range.from === range.to ? `on ${range.from}` : `from ${range.from} to ${range.to}`;
        const text =
          entries.length === 0
            ? `No eggs recorded ${when}.${latest ? ` The latest egg record is from ${latest}.` : ''}`
            : `${plural(totalEggs, 'egg')} collected ${when}${damagedEggs ? ` (${damagedEggs} damaged)` : ''}. By chicken: ${byChicken.map((c) => `${c.name} ${c.eggs}`).join(', ')}.` +
              (dayList.length <= 7 ? ` Per day: ${dayList.map((d) => `${d.date} ${d.eggs}`).join(', ')}.` : '');
        const demo = anyDemo(entries);
        const structured = { range, totalEggs, damagedEggs, days: dayList, byChicken, ...(latest ? { latestRecordDate: latest } : {}), notices: notices(demo, false), calculatedBy: 'server' as const };
        return respond(`${text}${demo ? ` ${DEMO_NOTICE}` : ''}`, structured);
      }),
  );

  server.registerTool(
    'get_health_records',
    {
      title: 'Animal health records',
      description:
        'Treatment history, upcoming and overdue vet follow-ups, and vaccinations that are overdue or due soon, from the farm\'s records. ' +
        'Use it for "which animal needs vaccination or follow-up", "when did Lakshmi see the vet". Never suggest a medicine or dose: a veterinarian decides those.',
      inputSchema: {
        ...animalRefInput,
        daysAhead: z.number().int().min(1).max(366).default(30).describe('How far ahead to look for follow-ups and vaccinations.'),
      },
      outputSchema: {
        asOf: z.string(),
        treatments: z.array(treatmentSchema).describe('Newest first.'),
        followUps: z.array(z.object({ treatmentId: z.string(), animalName: z.string().optional(), followUpDate: z.string(), daysLeft: z.number().int(), overdue: z.boolean(), reason: z.string() })),
        vaccinations: z.array(vaccinationSchema),
        vaccinationsDue: z.array(vaccinationSchema).describe('Overdue or due within daysAhead.'),
        notices: z.array(z.string()),
        calculatedBy: z.literal('server'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('get_health_records', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const animal = args.animalId || args.animalName ? await resolveAnimal(deps.records, farmId, args, { includeInactive: true }) : undefined;
        const mine = <T extends { animalId?: string }>(r: FarmRecord<T>) => !animal || r.data.animalId === animal.id;
        const [treatmentRecords, vaccinationRecords] = await Promise.all([deps.records.list<TreatmentData>(farmId, 'treatment'), deps.records.list<VaccinationData>(farmId, 'vaccination')]);
        const treatments = treatmentRecords.filter(mine).map((t) => treatmentView(t, today)).reverse();
        const until = addDays(today, args.daysAhead);
        const followUps = treatments
          .filter((t) => t.followUpDate && t.status !== 'completed' && t.followUpDate <= until)
          .map((t) => ({ treatmentId: t.treatmentId, ...(t.animalName ? { animalName: t.animalName } : {}), followUpDate: t.followUpDate!, daysLeft: t.followUpDaysLeft!, overdue: t.followUpDaysLeft! < 0, reason: t.symptoms }))
          .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));
        const vaccinations = vaccinationRecords.filter(mine).map((v) => vaccinationView(v, today)).sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
        const vaccinationsDue = vaccinations.filter((v) => v.nextDueDate <= until);
        const demo = anyDemo(treatmentRecords.filter(mine), vaccinationRecords.filter(mine));
        const who = animal?.data.name ? ` for ${animal.data.name}` : '';
        const parts = [
          followUps.length
            ? `Vet follow-ups${who}: ${followUps.map((f) => `${f.animalName ?? 'animal'} on ${f.followUpDate} (${dueText(f.daysLeft)}, ${f.reason})`).join('; ')}.`
            : `No vet follow-ups${who} due in the next ${plural(args.daysAhead, 'day')}.`,
          vaccinationsDue.length
            ? `Vaccinations${who} overdue or due soon: ${vaccinationsDue.map((v) => `${v.animalName ?? 'animal'} ${v.vaccine} due ${v.nextDueDate} (${dueText(v.daysLeft)})`).join('; ')}.`
            : `No vaccinations${who} overdue or due in the next ${plural(args.daysAhead, 'day')}.`,
          `${plural(treatments.length, 'treatment')} on record${treatments[0] ? `, latest ${treatments[0].date} (${treatments[0].animalName ?? 'animal'}, ${treatments[0].symptoms})` : ''}.`,
        ];
        const structured = { asOf: today, treatments, followUps, vaccinations, vaccinationsDue, notices: notices(demo, true), calculatedBy: 'server' as const };
        return respond(`${parts.join(' ')} ${[...(demo ? [DEMO_NOTICE] : []), VET_NOTICE].join(' ')}`, structured);
      }),
  );

  server.registerTool(
    'get_feed_stock',
    {
      title: 'Feed stock',
      description: 'Feed and fodder in stock with reorder alerts (at or below the reorder level). Use it for "how much feed is left", "what feed should I buy".',
      inputSchema: {},
      outputSchema: {
        items: z.array(
          z.object({
            feedId: z.string(),
            item: z.string(),
            quantity: z.number(),
            unit: z.string(),
            quantityDisplay: z.string(),
            reorderLevel: z.number(),
            reorderLevelDisplay: z.string(),
            needsReorder: z.boolean(),
            lastUpdated: z.string(),
            demo: z.boolean().optional(),
          }),
        ),
        reorderCount: z.number().int(),
        notices: z.array(z.string()),
        calculatedBy: z.literal('server'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      runTool('get_feed_stock', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const stock = await deps.records.list<FeedData>(farmId, 'feed');
        const amount = (n: number, unit: string) => `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)} ${unit.replaceAll('_', ' ')}`;
        const items = stock
          .map((f) => ({
            feedId: f.id,
            item: f.data.item,
            quantity: f.data.quantity,
            unit: f.data.unit,
            quantityDisplay: amount(f.data.quantity, f.data.unit),
            reorderLevel: f.data.reorderLevel,
            reorderLevelDisplay: amount(f.data.reorderLevel, f.data.unit),
            needsReorder: f.data.quantity <= f.data.reorderLevel,
            lastUpdated: f.data.lastUpdated,
            ...(f.data.demo ? { demo: true } : {}),
          }))
          .sort((a, b) => Number(b.needsReorder) - Number(a.needsReorder) || a.item.localeCompare(b.item));
        const low = items.filter((i) => i.needsReorder);
        const text =
          items.length === 0
            ? 'No feed stock is recorded.'
            : `${low.length ? `Reorder ${plural(low.length, 'item')}: ${low.map((i) => `${i.item} (${i.quantityDisplay} left, reorder at ${i.reorderLevelDisplay})`).join('; ')}.` : 'No feed needs reordering.'} ` +
              `In stock: ${items.filter((i) => !i.needsReorder).map((i) => `${i.item} ${i.quantityDisplay}`).join(', ') || 'nothing above its reorder level'}.`;
        const demo = anyDemo(stock);
        const structured = { items, reorderCount: low.length, notices: notices(demo, false), calculatedBy: 'server' as const };
        return respond(`${text}${demo ? ` ${DEMO_NOTICE}` : ''}`, structured);
      }),
  );

  server.registerTool(
    'get_animal_profile',
    {
      title: 'Animal profile',
      description: 'Everything recorded about one animal: details, mother and calves, milk in the last 7 days, insurance, treatments and vaccinations.',
      inputSchema: { ...animalRefInput },
      outputSchema: {
        animal: animalViewSchema,
        calves: z.array(z.object({ animalId: z.string(), name: z.string().optional(), type: z.string(), age: z.string().optional() })),
        milkLast7Days: z.object({ totalDisplay: z.string(), days: z.array(z.object({ date: z.string(), display: z.string() })) }),
        insurance: z.array(policySchema),
        treatments: z.array(treatmentSchema),
        vaccinations: z.array(vaccinationSchema),
        notices: z.array(z.string()),
        calculatedBy: z.literal('server'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('get_animal_profile', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const target = await resolveAnimal(deps.records, farmId, args, { includeInactive: true });
        const [animals, milk, policies, treatments, vaccinations] = await Promise.all([
          deps.records.list<AnimalData>(farmId, 'animal'),
          deps.records.list<MilkData>(farmId, 'milk', { from: addDays(today, -6), to: today }),
          deps.records.list<InsuranceData>(farmId, 'insurance'),
          deps.records.list<TreatmentData>(farmId, 'treatment'),
          deps.records.list<VaccinationData>(farmId, 'vaccination'),
        ]);
        const own = <T extends { animalId?: string }>(r: FarmRecord<T>) => r.data.animalId === target.id;
        const mine = { policies: policies.filter(own), treatments: treatments.filter(own), vaccinations: vaccinations.filter(own) };
        const insurance = mine.policies.map((p) => policyView(p, today));
        const calves = animals
          .filter((a) => a.data.motherId === target.id)
          .map((a) => ({ animalId: a.id, ...(a.data.name ? { name: a.data.name } : {}), type: a.data.type, ...(ageDisplay(a.data.birthDate, today) ? { age: ageDisplay(a.data.birthDate, today)! } : {}) }));
        const perDay = new Map<string, number>();
        for (const m of milk.filter(own)) perDay.set(m.data.date, (perDay.get(m.data.date) ?? 0) + m.data.millilitres);
        const milkTotal = [...perDay.values()].reduce((a, b) => a + b, 0);
        const latestPolicy = [...mine.policies].sort((a, b) => b.data.endDate.localeCompare(a.data.endDate))[0];
        const animal = toAnimalView(target, today, latestPolicy?.data.endDate);
        const demo = !!target.data.demo;
        const health = mine.treatments.length + mine.vaccinations.length > 0;
        const d = target.data;
        const text = [
          `${d.name ?? `Tag ${d.tagNumber}`}${d.nameKn ? ` (${d.nameKn})` : ''}: ${d.type}${d.breed ? `, ${d.breed}` : ''}${animal.age ? `, ${animal.age} old` : ''}${d.motherName ? `, mother ${d.motherName}` : ''}.`,
          calves.length ? `Calves: ${calves.map((c) => c.name ?? c.type).join(', ')}.` : '',
          perDay.size ? `Milk in the last 7 days: ${formatLitres(milkTotal)} over ${plural(perDay.size, 'day')}.` : '',
          insurance[0] ? `Insurance: ${insurance.map((p) => `${p.insurer} ends ${p.endDate} (${p.status.replace('_', ' ')})`).join('; ')}.` : 'No insurance recorded.',
          health ? `${plural(mine.treatments.length, 'treatment')} and ${plural(mine.vaccinations.length, 'vaccination')} on record.` : '',
          demo ? DEMO_NOTICE : '',
          health ? VET_NOTICE : '',
        ]
          .filter(Boolean)
          .join(' ');
        const structured = {
          animal,
          calves,
          milkLast7Days: { totalDisplay: formatLitres(milkTotal), days: [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, ml]) => ({ date, display: formatLitres(ml) })) },
          insurance,
          treatments: mine.treatments.map((t) => treatmentView(t, today)).reverse(),
          vaccinations: mine.vaccinations.map((v) => vaccinationView(v, today)),
          notices: notices(demo, health),
          calculatedBy: 'server' as const,
        };
        return respond(text, structured);
      }),
  );
}
