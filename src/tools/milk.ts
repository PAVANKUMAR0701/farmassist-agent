/** Milk production: record_milk, get_milk_summary, get_milk_value. Litres are stored as whole millilitres. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { IdempotencyConflictError, TooManyEntriesError } from '../repositories/ledger-repository.js';
import { newRecordId } from '../repositories/record-store.js';
import { formatPaise, hasAtMostTwoDecimals, rupeesToPaise } from '../shared/money.js';
import { formatLitres, hasAtMostDecimals, litresToMillilitres } from '../shared/quantity.js';
import { todayInFarmTimeZone } from '../shared/time.js';
import { animalRefInput, optionalText, plural, resolveAnimal } from './farm-shared.js';
import { clientRequestIdInput, dateRangeInput, entryDateInput, idempotencyFor, resolveDateRange, resolveEntryDate, type ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

const SESSIONS = ['morning', 'evening', 'whole_day'] as const;

/** Individual milk records are listed in a summary up to this many (a month of one cow, or a day of a herd). */
const MAX_LISTED_RECORDS = 31;

interface MilkData extends Record<string, unknown> {
  date: string;
  millilitres: number;
  session: (typeof SESSIONS)[number];
  animalId?: string;
  animalName?: string;
  note?: string;
}

const milkViewSchema = z.object({
  milkId: z.string(),
  date: z.string(),
  session: z.string(),
  millilitres: z.number().int(),
  litresDisplay: z.string(),
  animalId: z.string().optional(),
  animalName: z.string().optional(),
  note: z.string().optional(),
});

const view = (id: string, d: MilkData) => ({ milkId: id, ...d, litresDisplay: formatLitres(d.millilitres) });

export function registerMilkTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'record_milk',
    {
      title: 'Record milk',
      description:
        'Records milk produced, in litres, for one animal or for the whole herd (no animal given). ' +
        'For "Lakshmi gave 8 litres in the morning" use animalName "Lakshmi" and session "morning". One call per animal per session.',
      inputSchema: {
        litres: z
          .number()
          .positive()
          .max(500)
          .refine((v) => hasAtMostDecimals(v, 2), 'litres can have at most 2 decimal places')
          .describe('Litres of milk, as stated by the farmer. Never guess.'),
        session: z.enum(SESSIONS).default('whole_day').describe('"morning", "evening", or "whole_day" for a day\'s total.'),
        ...animalRefInput,
        date: entryDateInput,
        note: optionalText(200, 'Anything else, in the farmer\'s words.'),
        clientRequestId: clientRequestIdInput,
      },
      outputSchema: { milk: milkViewSchema, duplicate: z.boolean(), dayTotalMillilitres: z.number().int(), dayTotalDisplay: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('record_milk', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const date = resolveEntryDate(args.date, today);
        const animal = args.animalId || args.animalName ? await resolveAnimal(deps.records, farmId, args) : undefined;
        const data: MilkData = {
          date,
          millilitres: litresToMillilitres(args.litres),
          session: args.session,
          ...(animal ? { animalId: animal.id, ...(animal.data.name ? { animalName: animal.data.name } : {}) } : {}),
          ...(args.note ? { note: args.note } : {}),
        };
        const idempotency = idempotencyFor(args.clientRequestId, 'record_milk', [args.litres, args.session, animal?.id ?? null, args.date ?? null, args.note ?? null]);
        let result;
        try {
          result = await deps.records.create(farmId, newRecordId('milk', { date }), data, idempotency);
        } catch (error) {
          if (error instanceof IdempotencyConflictError) throw new ToolUserError(error.message);
          throw error;
        }
        const day = await deps.records.list<MilkData>(farmId, 'milk', { from: date, to: date });
        const dayTotal = day.reduce((sum, m) => sum + m.data.millilitres, 0);
        const who = data.animalName ? ` from ${data.animalName}` : ' (whole herd)';
        const when = data.session === 'whole_day' ? '' : ` (${data.session})`;
        const text = `${result.duplicate ? 'Already recorded earlier (no duplicate created):' : 'Recorded'} ${formatLitres(data.millilitres)} of milk${who}${when} on ${date}. Milk recorded on ${date} so far: ${formatLitres(dayTotal)}.`;
        const structured = { milk: view(result.record.id, result.record.data), duplicate: result.duplicate, dayTotalMillilitres: dayTotal, dayTotalDisplay: formatLitres(dayTotal) };
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }], structuredContent: structured };
      }),
  );

  server.registerTool(
    'get_milk_summary',
    {
      title: 'Milk totals',
      description:
        'Verified milk totals for a period (default: last 7 days), optionally for one animal, by day or by animal, with the average per recorded day. ' +
        'Use it for "how much milk this week", "how much does Lakshmi give". For each cow, per cow, which cow, or a list of cows\' milk use groupBy "animal". ' +
        'It also lists the individual records (date, session, cow or whole herd, litres) when there are few enough; quote those for "each record". ' +
        'Repeat the returned *Display values exactly; never add a cow or record that is not listed.',
      inputSchema: {
        ...dateRangeInput,
        ...animalRefInput,
        groupBy: z.enum(['day', 'animal']).default('day'),
      },
      outputSchema: {
        range: z.object({ from: z.string(), to: z.string(), label: z.string() }),
        animalName: z.string().optional(),
        totalMillilitres: z.number().int(),
        totalDisplay: z.string(),
        entryCount: z.number().int(),
        daysWithRecords: z.number().int(),
        averagePerRecordedDayDisplay: z.string().optional(),
        groups: z.array(z.object({ key: z.string(), millilitres: z.number().int(), display: z.string(), entryCount: z.number().int() })),
        records: z
          .array(z.object({ date: z.string(), session: z.string(), animalName: z.string(), litresDisplay: z.string() }))
          .optional()
          .describe(`Each milk record, oldest first, when there are at most ${MAX_LISTED_RECORDS}. "whole herd" means it was not recorded for one animal.`),
        calculatedBy: z.literal('server'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('get_milk_summary', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const range = resolveDateRange(args.period || args.from || args.to ? args : { period: 'last_7_days' }, today);
        const animal = args.animalId || args.animalName ? await resolveAnimal(deps.records, farmId, args, { includeInactive: true }) : undefined;
        let entries;
        try {
          entries = await deps.records.list<MilkData>(farmId, 'milk', { from: range.from, to: range.to });
        } catch (error) {
          if (error instanceof TooManyEntriesError) throw new ToolUserError(error.message);
          throw error;
        }
        if (animal) entries = entries.filter((m) => m.data.animalId === animal.id);
        const total = entries.reduce((sum, m) => sum + m.data.millilitres, 0);
        const groups = new Map<string, { millilitres: number; entryCount: number }>();
        for (const m of entries) {
          const key = args.groupBy === 'day' ? m.data.date : (m.data.animalName ?? 'whole herd');
          const g = groups.get(key) ?? { millilitres: 0, entryCount: 0 };
          g.millilitres += m.data.millilitres;
          g.entryCount++;
          groups.set(key, g);
        }
        const days = new Set(entries.map((m) => m.data.date)).size;
        const records =
          entries.length > 0 && entries.length <= MAX_LISTED_RECORDS
            ? [...entries]
                .sort((a, b) => a.data.date.localeCompare(b.data.date) || SESSIONS.indexOf(a.data.session) - SESSIONS.indexOf(b.data.session))
                .map((m) => ({ date: m.data.date, session: m.data.session, animalName: m.data.animalName ?? 'whole herd', litresDisplay: formatLitres(m.data.millilitres) }))
            : undefined;
        const average = days > 0 ? Math.round(total / days) : undefined;
        const sorted = [...groups.entries()]
          .map(([key, g]) => ({ key, ...g, display: formatLitres(g.millilitres) }))
          .sort((a, b) => (args.groupBy === 'day' ? a.key.localeCompare(b.key) : b.millilitres - a.millilitres || a.key.localeCompare(b.key)));
        const structured = {
          range,
          ...(animal?.data.name ? { animalName: animal.data.name } : {}),
          totalMillilitres: total,
          totalDisplay: formatLitres(total),
          entryCount: entries.length,
          daysWithRecords: days,
          ...(average !== undefined ? { averagePerRecordedDayDisplay: formatLitres(average) } : {}),
          groups: sorted,
          ...(records ? { records } : {}),
          calculatedBy: 'server' as const,
        };
        const whose = animal?.data.name ? ` from ${animal.data.name}` : '';
        // Per cow and per record in the text too, so "each cow's milk today" can be answered from what the
        // model reads (seen live 2026-10-21: only the 18 L total came back for that question).
        const text =
          entries.length === 0
            ? `No milk recorded${whose} from ${range.from} to ${range.to}.`
            : `Milk${whose} from ${range.from} to ${range.to}: ${structured.totalDisplay} over ${plural(days, 'day')} with records (average ${structured.averagePerRecordedDayDisplay} per day).` +
              (args.groupBy === 'animal' && sorted.length > 0 ? ` By animal: ${sorted.map((g) => `${g.key} ${g.display}`).join(', ')}.` : '') +
              (records ? ` Records: ${records.map((r) => `${r.date} ${r.session.replace("_", " ")} ${r.animalName} ${r.litresDisplay}`).join('; ')}.` : '');
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }], structuredContent: structured };
      }),
  );

  // The farmer's own rate times the recorded litres, worked out here in whole paise. The model must not do this
  // arithmetic itself: its numbers are checked against tool results, so "18 L at ₹36.5 = ₹657" was replaced
  // by a plain milk summary (seen live 2026-10-21).
  server.registerTool(
    'get_milk_value',
    {
      title: 'Value of milk at a rate',
      description:
        'Money value of the milk recorded in a period at the farmer\'s price per litre: litres x rate, worked out exactly by the server, ' +
        'total and per animal. Use it for "how much is today\'s milk worth at ₹36.5 a litre" or "total amount in rupees for the milk". ' +
        'Never multiply yourself. If the farmer has not said a rate in this conversation, ask for the price per litre first.',
      inputSchema: {
        ...dateRangeInput,
        ...animalRefInput,
        ratePerLitreRupees: z
          .number()
          .positive()
          .max(1000)
          .refine(hasAtMostTwoDecimals, 'the rate can have at most 2 decimal places')
          .describe('Price per litre in rupees, as the farmer said it, e.g. 36.5.'),
      },
      outputSchema: {
        range: z.object({ from: z.string(), to: z.string(), label: z.string() }),
        animalName: z.string().optional(),
        totalMillilitres: z.number().int(),
        litresDisplay: z.string(),
        rateDisplay: z.string(),
        valuePaise: z.number().int(),
        valueDisplay: z.string(),
        byAnimal: z.array(z.object({ key: z.string(), litresDisplay: z.string(), valueDisplay: z.string() })),
        calculatedBy: z.literal('server'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('get_milk_value', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const range = resolveDateRange(args.period || args.from || args.to ? args : { period: 'today' }, today);
        const animal = args.animalId || args.animalName ? await resolveAnimal(deps.records, farmId, args, { includeInactive: true }) : undefined;
        const ratePaise = rupeesToPaise(args.ratePerLitreRupees);
        let entries;
        try {
          entries = await deps.records.list<MilkData>(farmId, 'milk', { from: range.from, to: range.to });
        } catch (error) {
          if (error instanceof TooManyEntriesError) throw new ToolUserError(error.message);
          throw error;
        }
        if (animal) entries = entries.filter((m) => m.data.animalId === animal.id);
        // paise = millilitres x paise-per-litre / 1000, rounded once at the end of each sum.
        const valueOf = (ml: number) => Math.round((ml * ratePaise) / 1000);
        const total = entries.reduce((sum, m) => sum + m.data.millilitres, 0);
        const perAnimal = new Map<string, number>();
        for (const m of entries) {
          const key = m.data.animalName ?? 'whole herd';
          perAnimal.set(key, (perAnimal.get(key) ?? 0) + m.data.millilitres);
        }
        const byAnimal = [...perAnimal.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([key, ml]) => ({ key, litresDisplay: formatLitres(ml), valueDisplay: formatPaise(valueOf(ml)) }));
        const structured = {
          range,
          ...(animal?.data.name ? { animalName: animal.data.name } : {}),
          totalMillilitres: total,
          litresDisplay: formatLitres(total),
          rateDisplay: `${formatPaise(ratePaise)} per litre`,
          valuePaise: valueOf(total),
          valueDisplay: formatPaise(valueOf(total)),
          byAnimal,
          calculatedBy: 'server' as const,
        };
        const whose = animal?.data.name ? ` from ${animal.data.name}` : '';
        const text =
          entries.length === 0
            ? `No milk recorded${whose} from ${range.from} to ${range.to}, so there is nothing to value.`
            : `Milk${whose} from ${range.from} to ${range.to}: ${structured.litresDisplay} at ${structured.rateDisplay} = ${structured.valueDisplay}.` +
              (byAnimal.length > 1 ? ` By animal: ${byAnimal.map((g) => `${g.key} ${g.litresDisplay} = ${g.valueDisplay}`).join(', ')}.` : '');
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }], structuredContent: structured };
      }),
  );
}
