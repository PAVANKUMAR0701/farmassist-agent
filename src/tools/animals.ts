/** Herd register: register_animal, update_animal, list_animals. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { ConcurrentModificationError, IdempotencyConflictError } from '../repositories/ledger-repository.js';
import { newRecordId, type FarmRecord } from '../repositories/record-store.js';
import { formatPaise } from '../shared/money.js';
import { formatLitres } from '../shared/quantity.js';
import { todayInFarmTimeZone } from '../shared/time.js';
import {
  ageDisplay,
  ANIMAL_STATUSES,
  ANIMAL_TYPES,
  animalLabel,
  animalRefInput,
  countByType,
  describeCounts,
  optionalText,
  plural,
  resolveAnimal,
  sameName,
  type AnimalData,
} from './farm-shared.js';
import { clientRequestIdInput, idempotencyFor, resolveEntryDate, type ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

const animalFields = {
  name: optionalText(40, 'The animal\'s name, e.g. "Lakshmi". Ask for it if the farmer has not given one and there is no tag number.'),
  type: z.enum(ANIMAL_TYPES).describe('Kind of animal. A young cow or buffalo is a "calf"; a young female that has not calved yet is a "heifer".'),
  breed: optionalText(40, 'Breed in the farmer\'s words, e.g. "HF", "Jersey", "Gir", "Murrah", "desi".'),
  sex: z.enum(['female', 'male']).optional(),
  tagNumber: optionalText(30, 'Ear-tag or registration number, if any.'),
  birthDate: z.string().optional().describe('Birth date YYYY-MM-DD, if known.'),
  motherName: optionalText(40, 'Name of the mother, e.g. for a calf born on the farm.'),
  acquiredDate: z.string().optional().describe('Date bought or brought to the farm, YYYY-MM-DD. Omit for animals born on the farm.'),
  notes: optionalText(200, 'Anything else in the farmer\'s words.'),
};

export const animalViewSchema = z.object({
  animalId: z.string(),
  name: z.string().optional(),
  type: z.string(),
  breed: z.string().optional(),
  sex: z.string().optional(),
  tagNumber: z.string().optional(),
  birthDate: z.string().optional(),
  age: z.string().optional().describe('Worked out by FarmAssist from the birth date.'),
  motherName: z.string().optional(),
  acquiredDate: z.string().optional(),
  status: z.string(),
  statusDate: z.string().optional(),
  notes: z.string().optional(),
  insuredUntil: z.string().optional().describe('End date of the latest insurance policy, if any.'),
  nameKn: z.string().optional().describe('Name in Kannada, if recorded.'),
  motherId: z.string().optional(),
  lactationStatus: z.string().optional(),
  healthStatus: z.string().optional(),
  usualDailyMillilitres: z.number().int().optional(),
  usualDailyDisplay: z.string().optional().describe('Usual milk per day as recorded on the animal.'),
  purchaseValuePaise: z.number().int().optional(),
  purchaseValueDisplay: z.string().optional(),
  milkFeeding: z.string().optional(),
  sourceId: z.string().optional().describe('Id in the imported demo data, e.g. COW-001.'),
  demo: z.boolean().optional().describe('True for imported demo data (not real farm records).'),
});

export function toAnimalView(record: FarmRecord<AnimalData>, today: string, insuredUntil?: string): z.infer<typeof animalViewSchema> {
  const { status, ...rest } = record.data;
  const view: Record<string, unknown> = { animalId: record.id, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), status };
  const age = status === 'active' ? ageDisplay(record.data.birthDate, today) : undefined;
  if (age) view.age = age;
  if (insuredUntil) view.insuredUntil = insuredUntil;
  if (record.data.usualDailyMillilitres !== undefined) view.usualDailyDisplay = formatLitres(record.data.usualDailyMillilitres);
  if (record.data.purchaseValuePaise !== undefined) view.purchaseValueDisplay = formatPaise(record.data.purchaseValuePaise);
  return view as z.infer<typeof animalViewSchema>;
}

function checkDates(data: { birthDate?: string | undefined; acquiredDate?: string | undefined }, today: string) {
  if (data.birthDate) resolveEntryDate(data.birthDate, today);
  if (data.acquiredDate) resolveEntryDate(data.acquiredDate, today);
}

export function registerAnimalTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'register_animal',
    {
      title: 'Register animals',
      description:
        'Adds animals to the farm\'s herd register (cows, buffaloes, calves, ...). Put every animal the farmer mentions in one call: ' +
        'for "three new cows named Maya, Geeta and Saraswati" send three entries in animals. ' +
        'Use this, not record_farm_activity, whenever the farmer gets, names or registers animals.',
      inputSchema: {
        animals: z.array(z.object(animalFields)).min(1).max(10).describe('One entry per animal, in the order the farmer said them.'),
        clientRequestId: clientRequestIdInput,
      },
      outputSchema: {
        animals: z.array(animalViewSchema),
        duplicate: z.boolean().describe('True if this exact request was already saved earlier; nothing new was created.'),
        herd: z.array(z.object({ type: z.string(), count: z.number().int() })),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('register_animal', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const entries = args.animals.map((a, i): { data: AnimalData; idempotency: ReturnType<typeof idempotencyFor> } => {
          if (!a.name && !a.tagNumber) throw new ToolUserError(`animal ${i + 1} needs a name or a tag number (ask the farmer what it is called)`);
          checkDates(a, today);
          const data: AnimalData = {
            ...(a.name ? { name: a.name } : {}),
            type: a.type,
            ...(a.breed ? { breed: a.breed } : {}),
            ...(a.sex ? { sex: a.sex } : {}),
            ...(a.tagNumber ? { tagNumber: a.tagNumber } : {}),
            ...(a.birthDate ? { birthDate: a.birthDate } : {}),
            ...(a.motherName ? { motherName: a.motherName } : {}),
            ...(a.acquiredDate ? { acquiredDate: a.acquiredDate } : {}),
            status: 'active',
            ...(a.notes ? { notes: a.notes } : {}),
          };
          // One marker per animal, so a retried list completes without creating any animal twice.
          const id = args.clientRequestId ? `${args.clientRequestId}-${i + 1}` : undefined;
          return { data, idempotency: idempotencyFor(id, 'register_animal', [data]) };
        });

        let results: Array<{ record: FarmRecord<AnimalData>; duplicate: boolean }>;
        try {
          // Retries of animals already saved are found first, so they are not mistaken for name clashes.
          const earlier = await Promise.all(entries.map((e) => (e.idempotency ? deps.records.findCreated<AnimalData>(farmId, e.idempotency) : undefined)));
          const existing = (await deps.records.list<AnimalData>(farmId, 'animal')).filter((a) => a.data.status === 'active');
          const names = new Set<string>();
          entries.forEach((e, i) => {
            if (earlier[i] || !e.data.name) return;
            const key = e.data.name.toLowerCase();
            if (names.has(key)) throw new ToolUserError(`the name ${e.data.name} appears twice in this list`);
            names.add(key);
            const clash = existing.find((a) => sameName(a.data.name, e.data.name));
            if (clash) throw new ToolUserError(`an active animal is already called ${clash.data.name} (${animalLabel(clash.data)}). Use another name, or update_animal to change that one. Nothing was saved`);
          });
          results = [];
          for (const [i, e] of entries.entries()) {
            const found = earlier[i];
            results.push(found ? { record: found, duplicate: true } : await deps.records.create(farmId, newRecordId('animal'), e.data, e.idempotency));
          }
        } catch (error) {
          if (error instanceof IdempotencyConflictError) throw new ToolUserError(error.message);
          throw error;
        }

        const herd = countByType((await deps.records.list<AnimalData>(farmId, 'animal')).filter((a) => a.data.status === 'active').map((a) => a.data));
        const animals = results.map((r) => toAnimalView(r.record, today));
        const total = herd.reduce((n, h) => n + h.count, 0);
        const duplicate = results.every((r) => r.duplicate);
        const listText = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
        const text = `${duplicate ? 'Already registered earlier (no duplicate created):' : 'Registered'} ${listText(results.map((r) => animalLabel(r.record.data)))}. The herd now has ${plural(total, 'animal')}: ${describeCounts(herd)}.`;
        const structured = { animals, duplicate, herd };
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }], structuredContent: structured };
      }),
  );

  server.registerTool(
    'update_animal',
    {
      title: 'Update an animal',
      description:
        'Changes a registered animal\'s details: rename it, set its breed, tag, birth date or mother, or mark it sold or died. ' +
        'Find it by animalId or by its current name. Only the fields given are changed.',
      inputSchema: {
        ...animalRefInput,
        newName: optionalText(40, 'New name.'),
        type: z.enum(ANIMAL_TYPES).optional().describe('New kind, e.g. a calf that has grown into a "heifer" or "cow".'),
        breed: animalFields.breed,
        sex: animalFields.sex,
        tagNumber: animalFields.tagNumber,
        birthDate: animalFields.birthDate,
        motherName: animalFields.motherName,
        notes: optionalText(200, 'Replacement notes.'),
        status: z.enum(ANIMAL_STATUSES).optional().describe('"sold" or "died" removes the animal from the active herd; "active" brings it back.'),
        statusDate: z.string().optional().describe('When it was sold or died, YYYY-MM-DD. Omit for today.'),
      },
      outputSchema: { status: z.enum(['updated', 'no_change']), animal: animalViewSchema, changedFields: z.array(z.string()) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('update_animal', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        checkDates(args, today);
        const target = await resolveAnimal(deps.records, farmId, args, { includeInactive: true });
        const before = target.data;
        const after: AnimalData = { ...before };
        const changes: Array<[keyof AnimalData, unknown]> = [
          ['name', args.newName],
          ['type', args.type],
          ['breed', args.breed],
          ['sex', args.sex],
          ['tagNumber', args.tagNumber],
          ['birthDate', args.birthDate],
          ['motherName', args.motherName],
          ['notes', args.notes],
          ['status', args.status],
        ];
        for (const [field, value] of changes) if (value !== undefined) (after as Record<string, unknown>)[field] = value;
        if (args.status && args.status !== before.status) after.statusDate = args.status === 'active' ? undefined : resolveEntryDate(args.statusDate, today);
        if (after.statusDate === undefined) delete after.statusDate;
        if (args.newName && !sameName(args.newName, before.name)) {
          const clash = (await deps.records.list<AnimalData>(farmId, 'animal')).find((a) => a.id !== target.id && a.data.status === 'active' && sameName(a.data.name, args.newName));
          if (clash) throw new ToolUserError(`another active animal is already called ${clash.data.name} (id ${clash.id})`);
        }
        const changedFields = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
        if (changedFields.length === 0) {
          const animal = toAnimalView(target, today);
          return { content: [{ type: 'text' as const, text: `No change needed: ${animalLabel(before)} already has those details.` }], structuredContent: { status: 'no_change' as const, animal, changedFields } };
        }
        let saved;
        try {
          saved = await deps.records.update<AnimalData>(farmId, target.id, target.version, after);
        } catch (error) {
          if (error instanceof ConcurrentModificationError) throw new ToolUserError(error.message);
          throw error;
        }
        const animal = toAnimalView(saved, today);
        const what = changedFields.filter((f) => f !== 'statusDate').map((f) => `${f === 'name' ? 'name' : f} ${String(before[f] ?? '(none)')} → ${String(after[f] ?? '(none)')}`).join(', ');
        const text = `Updated ${animalLabel(after)}: ${what}.`;
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify({ status: 'updated', animal, changedFields })}` }], structuredContent: { status: 'updated' as const, animal, changedFields } };
      }),
  );

  server.registerTool(
    'list_animals',
    {
      title: 'List the herd',
      description: 'Lists registered animals with their details and counts by kind. Use it for "how many cows do I have", "what are my cows called", or to find an animal\'s id.',
      inputSchema: {
        status: z.enum(['active', 'sold', 'died', 'all']).default('active').describe('Default: animals currently on the farm.'),
        type: z.enum(ANIMAL_TYPES).optional().describe('Only this kind of animal.'),
      },
      outputSchema: {
        animals: z.array(animalViewSchema),
        total: z.number().int(),
        byType: z.array(z.object({ type: z.string(), count: z.number().int() })),
        calculatedBy: z.literal('server'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('list_animals', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const [all, policies] = await Promise.all([deps.records.list<AnimalData>(farmId, 'animal'), deps.records.list<{ animalId: string; endDate: string }>(farmId, 'insurance')]);
        const insuredUntil = new Map<string, string>();
        for (const p of policies) if ((insuredUntil.get(p.data.animalId) ?? '') < p.data.endDate) insuredUntil.set(p.data.animalId, p.data.endDate);
        const chosen = all
          .filter((a) => (args.status === 'all' || a.data.status === args.status) && (!args.type || a.data.type === args.type))
          .sort((a, b) => (a.data.name ?? a.data.tagNumber ?? '').localeCompare(b.data.name ?? b.data.tagNumber ?? ''));
        const animals = chosen.map((a) => toAnimalView(a, today, insuredUntil.get(a.id)));
        const byType = countByType(chosen.map((a) => a.data));
        const which = args.status === 'all' ? '' : `${args.status} `;
        const text =
          animals.length === 0
            ? `No ${which}${args.type ?? 'animal'}s are registered.`
            : `${plural(animals.length, `${which}animal`)}: ${byType.map((t) => `${describeCounts([t])} (${chosen.filter((a) => a.data.type === t.type).map((a) => a.data.name ?? `tag ${a.data.tagNumber}`).join(', ')})`).join('; ')}.`;
        const structured = { animals, total: animals.length, byType, calculatedBy: 'server' as const };
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }], structuredContent: structured };
      }),
  );
}
