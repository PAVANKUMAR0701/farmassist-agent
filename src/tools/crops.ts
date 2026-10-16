/** Crop cycles: record_sowing, record_harvest, list_crops. Masses are stored in grams, area in hundredths of an acre. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { ConcurrentModificationError, IdempotencyConflictError } from '../repositories/ledger-repository.js';
import { newRecordId, type FarmRecord, type RecordStore } from '../repositories/record-store.js';
import { acresToHundredths, formatAcres, formatMass, hasAtMostDecimals, MASS_UNITS, toGrams } from '../shared/quantity.js';
import { daysBetween, todayInFarmTimeZone } from '../shared/time.js';
import { optionalText, plural, sameName } from './farm-shared.js';
import { clientRequestIdInput, entryDateInput, idempotencyFor, resolveEntryDate, type ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

interface CropData extends Record<string, unknown> {
  crop: string;
  variety?: string;
  field: string;
  areaHundredths?: number;
  sownDate: string;
  seedGrams?: number;
  status: 'growing' | 'harvested';
  harvestedDate?: string;
  notes?: string;
}

interface HarvestData extends Record<string, unknown> {
  cropId: string;
  date: string;
  grams: number;
  note?: string;
}

const quantity = (max: number) =>
  z
    .number()
    .positive()
    .max(max)
    .refine((v) => hasAtMostDecimals(v, 3), 'at most 3 decimal places');

const cropViewSchema = z.object({
  cropId: z.string(),
  crop: z.string(),
  variety: z.string().optional(),
  field: z.string(),
  areaDisplay: z.string().optional(),
  sownDate: z.string(),
  daysSinceSowing: z.number().int(),
  seedDisplay: z.string().optional(),
  status: z.string(),
  harvestedDate: z.string().optional(),
  harvestCount: z.number().int(),
  harvestedGrams: z.number().int(),
  harvestedDisplay: z.string(),
  yieldPerAcreDisplay: z.string().optional().describe('Harvest divided by area, worked out by FarmAssist.'),
  harvestToSeedRatio: z.number().optional().describe('How many times the seed weight was harvested, worked out by FarmAssist.'),
  notes: z.string().optional(),
});

function cropView(record: FarmRecord<CropData>, harvests: Array<FarmRecord<HarvestData>>, today: string): z.infer<typeof cropViewSchema> {
  const d = record.data;
  const harvestedGrams = harvests.reduce((sum, h) => sum + h.data.grams, 0);
  const end = d.status === 'harvested' && d.harvestedDate ? d.harvestedDate : today;
  return {
    cropId: record.id,
    crop: d.crop,
    ...(d.variety ? { variety: d.variety } : {}),
    field: d.field,
    ...(d.areaHundredths ? { areaDisplay: formatAcres(d.areaHundredths) } : {}),
    sownDate: d.sownDate,
    daysSinceSowing: daysBetween(d.sownDate, end),
    ...(d.seedGrams ? { seedDisplay: formatMass(d.seedGrams) } : {}),
    status: d.status,
    ...(d.harvestedDate ? { harvestedDate: d.harvestedDate } : {}),
    harvestCount: harvests.length,
    harvestedGrams,
    harvestedDisplay: formatMass(harvestedGrams),
    ...(d.areaHundredths && harvestedGrams ? { yieldPerAcreDisplay: `${formatMass(Math.round((harvestedGrams * 100) / d.areaHundredths))} per acre` } : {}),
    ...(d.seedGrams && harvestedGrams ? { harvestToSeedRatio: Math.round((harvestedGrams / d.seedGrams) * 10) / 10 } : {}),
    ...(d.notes ? { notes: d.notes } : {}),
  };
}

const cropName = (crop: string) => crop.trim().toLowerCase();
const label = (d: CropData) => `${d.crop}${d.variety ? ` (${d.variety})` : ''} in ${d.field}`;

/** The crop a harvest belongs to: by id, or the single growing crop matching name (and field). Never guesses. */
async function resolveCrop(records: RecordStore, farmId: string, ref: { cropId?: string | undefined; crop?: string | undefined; field?: string | undefined }) {
  if (ref.cropId) {
    const found = await records.get<CropData>(farmId, ref.cropId);
    if (!found || found.kind !== 'crop') throw new ToolUserError(`no crop with id ${ref.cropId} was found; use list_crops to find it`);
    return found;
  }
  if (!ref.crop) throw new ToolUserError('say which crop: give cropId, or crop (and field)');
  const all = await records.list<CropData>(farmId, 'crop');
  const growing = all.filter((c) => c.data.status === 'growing');
  const matches = growing.filter((c) => c.data.crop === cropName(ref.crop!) && (!ref.field || sameName(c.data.field, ref.field)));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    const list = growing.map((c) => label(c.data)).join('; ');
    throw new ToolUserError(`no growing ${cropName(ref.crop)} crop${ref.field ? ` in ${ref.field}` : ''} is recorded${list ? ` (growing: ${list})` : ''}. Record the sowing first with record_sowing`);
  }
  throw new ToolUserError(`${matches.length} ${cropName(ref.crop)} crops are growing: ${matches.map((c) => `${label(c.data)} sown ${c.data.sownDate}, id ${c.id}`).join('; ')}. Ask which one, then use its cropId`);
}

export function registerCropTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'record_sowing',
    {
      title: 'Record sowing or planting',
      description:
        'Starts a crop cycle: which crop was sown or planted (paddy, ragi, sugarcane, ...), in which field, when, on how many acres and with how much seed. ' +
        'Harvests are recorded against it later with record_harvest.',
      inputSchema: {
        crop: z.string().trim().min(1).max(40).describe('Crop name, e.g. "paddy", "ragi", "sugarcane", "maize", "groundnut".'),
        variety: optionalText(40, 'Variety, if said, e.g. "Sona Masuri", "IR64".'),
        field: z.string().trim().min(1).max(40).describe('Which field or plot, in the farmer\'s words, e.g. "north field". Ask if not said.'),
        areaAcres: quantity(1000).optional().describe('Area in acres. Convert guntha (40 guntha = 1 acre) or cents (100 cents = 1 acre) only if the farmer used them.'),
        sownDate: entryDateInput,
        seedQuantity: quantity(100_000).optional().describe('Amount of seed or seedlings used, if said.'),
        seedUnit: z.enum(MASS_UNITS).default('kg'),
        notes: optionalText(200, 'Anything else, in the farmer\'s words.'),
        clientRequestId: clientRequestIdInput,
      },
      outputSchema: { crop: cropViewSchema, duplicate: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('record_sowing', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const sownDate = resolveEntryDate(args.sownDate, today);
        const data: CropData = {
          crop: cropName(args.crop),
          ...(args.variety ? { variety: args.variety } : {}),
          field: args.field,
          ...(args.areaAcres ? { areaHundredths: acresToHundredths(args.areaAcres) } : {}),
          sownDate,
          ...(args.seedQuantity ? { seedGrams: toGrams(args.seedQuantity, args.seedUnit) } : {}),
          status: 'growing',
          ...(args.notes ? { notes: args.notes } : {}),
        };
        let result;
        try {
          result = await deps.records.create(farmId, newRecordId('crop'), data, idempotencyFor(args.clientRequestId, 'record_sowing', [data]));
        } catch (error) {
          if (error instanceof IdempotencyConflictError) throw new ToolUserError(error.message);
          throw error;
        }
        const crop = cropView(result.record, [], today);
        const details = [crop.areaDisplay, crop.seedDisplay ? `${crop.seedDisplay} of seed` : undefined].filter(Boolean).join(', ');
        const text = `${result.duplicate ? 'Already recorded earlier (no duplicate created):' : 'Recorded sowing of'} ${label(data)} on ${sownDate}${details ? ` (${details})` : ''}.`;
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify({ crop, duplicate: result.duplicate })}` }], structuredContent: { crop, duplicate: result.duplicate } };
      }),
  );

  server.registerTool(
    'record_harvest',
    {
      title: 'Record a harvest',
      description:
        'Records how much was harvested from a crop that was sown earlier (record_sowing). Several pickings can be recorded for one crop; ' +
        'set final=true for the last one, which closes the crop cycle. Find the crop by cropId, or by crop name (and field).',
      inputSchema: {
        cropId: z.string().max(40).optional(),
        crop: z.string().trim().min(1).max(40).optional().describe('Crop name when you do not have its id.'),
        field: z.string().trim().min(1).max(40).optional().describe('Field, if several fields grow the same crop.'),
        quantity: quantity(10_000_000).describe('Amount harvested, exactly as the farmer said it. Do not convert: for "30 quintal" send 30 with unit "quintal".'),
        unit: z.enum(MASS_UNITS).default('kg').describe('The unit the farmer used. FarmAssist converts it (1 quintal = 100 kg, 1 tonne = 1000 kg).'),
        date: entryDateInput,
        final: z.boolean().default(false).describe('True when this is the last harvest of this crop cycle.'),
        note: optionalText(200, 'Anything else, e.g. where it was sold.'),
        clientRequestId: clientRequestIdInput,
      },
      outputSchema: { crop: cropViewSchema, harvestId: z.string(), harvestDisplay: z.string(), duplicate: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('record_harvest', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const date = resolveEntryDate(args.date, today);
        let crop = await resolveCrop(deps.records, farmId, args);
        if (date < crop.data.sownDate) throw new ToolUserError(`the harvest date ${date} is before this crop was sown (${crop.data.sownDate})`);
        const data: HarvestData = { cropId: crop.id, date, grams: toGrams(args.quantity, args.unit), ...(args.note ? { note: args.note } : {}) };
        let result;
        try {
          result = await deps.records.create(farmId, newRecordId('harvest', { cropId: crop.id }), data, idempotencyFor(args.clientRequestId, 'record_harvest', [data, args.final]));
          if (args.final && crop.data.status === 'growing' && !result.duplicate) {
            crop = await deps.records.update<CropData>(farmId, crop.id, crop.version, { ...crop.data, status: 'harvested', harvestedDate: date });
          }
        } catch (error) {
          if (error instanceof IdempotencyConflictError || error instanceof ConcurrentModificationError) throw new ToolUserError(error.message);
          throw error;
        }
        const harvests = await deps.records.list<HarvestData>(farmId, 'harvest', { cropId: crop.id });
        const view = cropView(crop, harvests, today);
        const text =
          `${result.duplicate ? 'Already recorded earlier (no duplicate created):' : 'Recorded harvest of'} ${formatMass(data.grams)} of ${label(crop.data)} on ${date}. ` +
          `Total harvested from this crop: ${view.harvestedDisplay}${view.yieldPerAcreDisplay ? `, ${view.yieldPerAcreDisplay}` : ''}${crop.data.status === 'harvested' ? '; crop cycle closed' : ''}.`;
        const structured = { crop: view, harvestId: result.record.id, harvestDisplay: formatMass(data.grams), duplicate: result.duplicate };
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }], structuredContent: structured };
      }),
  );

  server.registerTool(
    'list_crops',
    {
      title: 'List crops',
      description:
        'Lists crop cycles with sowing date, area, seed used, total harvested, yield per acre and harvest-to-seed ratio, all worked out by FarmAssist. ' +
        'Use it for "what did I plant", "how much paddy did I get", "compare ragi and paddy".',
      inputSchema: {
        status: z.enum(['growing', 'harvested', 'all']).default('all'),
        crop: z.string().trim().min(1).max(40).optional().describe('Only this crop.'),
      },
      outputSchema: { crops: z.array(cropViewSchema), calculatedBy: z.literal('server') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('list_crops', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const [crops, harvests] = await Promise.all([deps.records.list<CropData>(farmId, 'crop'), deps.records.list<HarvestData>(farmId, 'harvest')]);
        const chosen = crops
          .filter((c) => (args.status === 'all' || c.data.status === args.status) && (!args.crop || c.data.crop === cropName(args.crop)))
          .sort((a, b) => b.data.sownDate.localeCompare(a.data.sownDate));
        const views = chosen.map((c) => cropView(c, harvests.filter((h) => h.data.cropId === c.id), today));
        const text =
          views.length === 0
            ? `No ${args.status === 'all' ? '' : `${args.status} `}${args.crop ? `${cropName(args.crop)} ` : ''}crops recorded.`
            : `${plural(views.length, 'crop')}: ${views
                .slice(0, 5)
                .map((v) => `${v.crop} in ${v.field} sown ${v.sownDate} (${v.status}${v.harvestCount ? `, harvested ${v.harvestedDisplay}` : `, ${v.daysSinceSowing} days`})`)
                .join('; ')}.`;
        const structured = { crops: views, calculatedBy: 'server' as const };
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }], structuredContent: structured };
      }),
  );
}
