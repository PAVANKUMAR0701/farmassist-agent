/** Insurance and reminders: add_insurance, add_reminder, complete_reminder, list_reminders. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { ConcurrentModificationError, IdempotencyConflictError } from '../repositories/ledger-repository.js';
import { newRecordId } from '../repositories/record-store.js';
import { formatPaise, hasAtMostTwoDecimals, MAX_ENTRY_RUPEES, rupeesToPaise } from '../shared/money.js';
import { addDays, daysBetween, todayInFarmTimeZone } from '../shared/time.js';
import { animalLabel, animalRefInput, optionalText, plural, requireDate, resolveAnimal } from './farm-shared.js';
import { clientRequestIdInput, idempotencyFor, type ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

interface InsuranceData extends Record<string, unknown> {
  animalId: string;
  animalName?: string;
  insurer: string;
  policyNumber?: string;
  startDate?: string;
  endDate: string;
  premiumPaise?: number;
  sumInsuredPaise?: number;
  notes?: string;
}

interface ReminderData extends Record<string, unknown> {
  title: string;
  dueDate: string;
  animalId?: string;
  animalName?: string;
  notes?: string;
  status: 'open' | 'done';
  doneDate?: string;
}

const rupees = z
  .number()
  .positive()
  .max(MAX_ENTRY_RUPEES)
  .refine(hasAtMostTwoDecimals, 'at most 2 decimal places');

/** Insurance renewals appear in list_reminders from this many days before the end date. */
export const INSURANCE_NOTICE_DAYS = 30;
/** Reminders and policies can be set at most this far ahead. */
const MAX_DAYS_AHEAD = 5 * 366;

const dueText = (days: number) => (days < 0 ? `overdue by ${plural(-days, 'day')}` : days === 0 ? 'due today' : `in ${plural(days, 'day')}`);

export function registerReminderTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'add_insurance',
    {
      title: 'Save an animal insurance policy',
      description: 'Saves an insurance policy for one registered animal. Its end date then appears in list_reminders before it runs out.',
      inputSchema: {
        ...animalRefInput,
        insurer: z.string().trim().min(1).max(60).describe('Insurance company or scheme, e.g. "United India", "PMFBY", "dairy cooperative".'),
        policyNumber: optionalText(40, 'Policy number, if said.'),
        startDate: z.string().optional().describe('YYYY-MM-DD, if said.'),
        endDate: z.string().describe('When the cover ends, YYYY-MM-DD. Ask if not said: reminders depend on it.'),
        premiumRupees: rupees.optional().describe('Premium paid, if said.'),
        sumInsuredRupees: rupees.optional().describe('Amount covered, if said.'),
        notes: optionalText(200, 'Anything else.'),
        clientRequestId: clientRequestIdInput,
      },
      outputSchema: { insuranceId: z.string(), animalName: z.string().optional(), endDate: z.string(), daysLeft: z.number().int(), duplicate: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('add_insurance', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const endDate = requireDate('endDate', args.endDate);
        if (args.startDate) requireDate('startDate', args.startDate);
        if (args.startDate && args.startDate >= endDate) throw new ToolUserError(`the end date ${endDate} must be after the start date ${args.startDate}`);
        if (daysBetween(today, endDate) > MAX_DAYS_AHEAD) throw new ToolUserError('the end date is more than 5 years away; check the date');
        const animal = await resolveAnimal(deps.records, farmId, args);
        const data: InsuranceData = {
          animalId: animal.id,
          ...(animal.data.name ? { animalName: animal.data.name } : {}),
          insurer: args.insurer,
          ...(args.policyNumber ? { policyNumber: args.policyNumber } : {}),
          ...(args.startDate ? { startDate: args.startDate } : {}),
          endDate,
          ...(args.premiumRupees ? { premiumPaise: rupeesToPaise(args.premiumRupees) } : {}),
          ...(args.sumInsuredRupees ? { sumInsuredPaise: rupeesToPaise(args.sumInsuredRupees) } : {}),
          ...(args.notes ? { notes: args.notes } : {}),
        };
        let result;
        try {
          result = await deps.records.create(farmId, newRecordId('insurance'), data, idempotencyFor(args.clientRequestId, 'add_insurance', [data]));
        } catch (error) {
          if (error instanceof IdempotencyConflictError) throw new ToolUserError(error.message);
          throw error;
        }
        const daysLeft = daysBetween(today, endDate);
        const money = [data.premiumPaise ? `premium ${formatPaise(data.premiumPaise)}` : '', data.sumInsuredPaise ? `cover ${formatPaise(data.sumInsuredPaise)}` : ''].filter(Boolean).join(', ');
        const text =
          `${result.duplicate ? 'Already saved earlier (no duplicate created):' : 'Saved'} insurance for ${animalLabel(animal.data)} with ${data.insurer}${data.policyNumber ? ` (policy ${data.policyNumber})` : ''}` +
          `${money ? `, ${money}` : ''}, ending ${endDate} (${daysLeft < 0 ? 'already ended' : dueText(daysLeft)}). It will show in reminders from ${INSURANCE_NOTICE_DAYS} days before.`;
        const structured = { insuranceId: result.record.id, ...(data.animalName ? { animalName: data.animalName } : {}), endDate, daysLeft, duplicate: result.duplicate };
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }], structuredContent: structured };
      }),
  );

  server.registerTool(
    'add_reminder',
    {
      title: 'Add a reminder',
      description: 'Saves a reminder for a date, e.g. "remind me to deworm Lakshmi on 2026-11-01", "pay the loan on the 5th". It appears in list_reminders.',
      inputSchema: {
        title: z.string().trim().min(1).max(100).describe('What to remember, in the farmer\'s words.'),
        dueDate: z.string().describe('YYYY-MM-DD. Work out dates like "next Monday" from today\'s date; ask if unclear.'),
        ...animalRefInput,
        notes: optionalText(200, 'Anything else.'),
        clientRequestId: clientRequestIdInput,
      },
      outputSchema: { reminderId: z.string(), title: z.string(), dueDate: z.string(), daysLeft: z.number().int(), duplicate: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('add_reminder', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const dueDate = requireDate('dueDate', args.dueDate);
        if (dueDate < today) throw new ToolUserError(`${dueDate} is in the past (today is ${today}); reminders are for today or later`);
        if (daysBetween(today, dueDate) > MAX_DAYS_AHEAD) throw new ToolUserError('the date is more than 5 years away; check the date');
        const animal = args.animalId || args.animalName ? await resolveAnimal(deps.records, farmId, args) : undefined;
        const data: ReminderData = {
          title: args.title,
          dueDate,
          ...(animal ? { animalId: animal.id, ...(animal.data.name ? { animalName: animal.data.name } : {}) } : {}),
          ...(args.notes ? { notes: args.notes } : {}),
          status: 'open',
        };
        let result;
        try {
          result = await deps.records.create(farmId, newRecordId('reminder', { date: dueDate }), data, idempotencyFor(args.clientRequestId, 'add_reminder', [data]));
        } catch (error) {
          if (error instanceof IdempotencyConflictError) throw new ToolUserError(error.message);
          throw error;
        }
        const daysLeft = daysBetween(today, dueDate);
        const text = `${result.duplicate ? 'Already saved earlier (no duplicate created):' : 'Reminder saved:'} "${data.title}"${data.animalName ? ` for ${data.animalName}` : ''} on ${dueDate} (${dueText(daysLeft)}).`;
        const structured = { reminderId: result.record.id, title: data.title, dueDate, daysLeft, duplicate: result.duplicate };
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }], structuredContent: structured };
      }),
  );

  server.registerTool(
    'complete_reminder',
    {
      title: 'Mark a reminder done',
      description: 'Marks a reminder as done so it no longer shows. Use the reminderId from list_reminders.',
      inputSchema: { reminderId: z.string().max(60) },
      outputSchema: { reminderId: z.string(), title: z.string(), status: z.enum(['done', 'already_done']) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('complete_reminder', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const reminder = await deps.records.get<ReminderData>(farmId, args.reminderId);
        if (!reminder || reminder.kind !== 'reminder') throw new ToolUserError(`no reminder with id ${args.reminderId}; use list_reminders to find it`);
        if (reminder.data.status === 'done') {
          return { content: [{ type: 'text' as const, text: `"${reminder.data.title}" was already marked done.` }], structuredContent: { reminderId: reminder.id, title: reminder.data.title, status: 'already_done' as const } };
        }
        try {
          await deps.records.update<ReminderData>(farmId, reminder.id, reminder.version, { ...reminder.data, status: 'done', doneDate: todayInFarmTimeZone(deps.now()) });
        } catch (error) {
          if (error instanceof ConcurrentModificationError) throw new ToolUserError(error.message);
          throw error;
        }
        return { content: [{ type: 'text' as const, text: `Marked done: "${reminder.data.title}".` }], structuredContent: { reminderId: reminder.id, title: reminder.data.title, status: 'done' as const } };
      }),
  );

  server.registerTool(
    'list_reminders',
    {
      title: 'Upcoming reminders',
      description:
        'What is coming up: open reminders due within the next days (default 30), anything overdue, and animal insurance that ends soon. ' +
        'Use it for "what do I need to do", "any reminders", "when does Lakshmi\'s insurance end".',
      inputSchema: { daysAhead: z.number().int().min(1).max(366).default(30) },
      outputSchema: {
        items: z.array(
          z.object({
            source: z.enum(['reminder', 'insurance']),
            id: z.string(),
            title: z.string(),
            dueDate: z.string(),
            daysLeft: z.number().int(),
            overdue: z.boolean(),
            animalName: z.string().optional(),
          }),
        ),
        calculatedBy: z.literal('server'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('list_reminders', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const until = addDays(today, args.daysAhead);
        const [reminders, policies] = await Promise.all([
          deps.records.list<ReminderData>(farmId, 'reminder', { to: until }),
          deps.records.list<InsuranceData>(farmId, 'insurance'),
        ]);
        const items = [
          ...reminders
            .filter((r) => r.data.status === 'open')
            .map((r) => ({ source: 'reminder' as const, id: r.id, title: r.data.title, dueDate: r.data.dueDate, animalName: r.data.animalName })),
          ...policies
            .filter((p) => p.data.endDate <= addDays(today, Math.max(args.daysAhead, INSURANCE_NOTICE_DAYS)) && p.data.endDate >= addDays(today, -INSURANCE_NOTICE_DAYS))
            .map((p) => ({
              source: 'insurance' as const,
              id: p.id,
              title: `Insurance for ${p.data.animalName ?? 'animal'} with ${p.data.insurer} ${p.data.endDate < today ? 'ended' : 'ends'}${p.data.policyNumber ? ` (policy ${p.data.policyNumber})` : ''}`,
              dueDate: p.data.endDate,
              animalName: p.data.animalName,
            })),
        ]
          .map((i) => ({ ...i, daysLeft: daysBetween(today, i.dueDate), overdue: i.dueDate < today, ...(i.animalName ? {} : { animalName: undefined }) }))
          .map(({ animalName, ...rest }) => ({ ...rest, ...(animalName ? { animalName } : {}) }))
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
        const text =
          items.length === 0
            ? `Nothing due in the next ${plural(args.daysAhead, 'day')}.`
            : `${plural(items.length, 'thing')} coming up: ${items.map((i) => `${i.title} ${i.source === 'insurance' && !i.overdue ? `on ${i.dueDate}` : `(${i.dueDate})`}, ${dueText(i.daysLeft)}`).join('; ')}.`;
        const structured = { items, calculatedBy: 'server' as const };
        return { content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }], structuredContent: structured };
      }),
  );
}
