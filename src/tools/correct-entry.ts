import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { applyChanges, snapshotOf, type CorrectableField, type ExpenseSnapshot } from '../domain/correction.js';
import { parseEntryId } from '../domain/entry-id.js';
import { EXPENSE_CATEGORIES, type ExpenseEntry } from '../domain/expense.js';
import { ConcurrentModificationError, EntryNotFoundError } from '../repositories/ledger-repository.js';
import { formatPaise, hasAtMostTwoDecimals, MAX_ENTRY_RUPEES, rupeesToPaise } from '../shared/money.js';
import { todayInFarmTimeZone } from '../shared/time.js';
import { entryViewSchema, resolveEntryDate, toEntryView, type ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

const inputSchema = {
  entryId: z
    .string()
    .optional()
    .describe('Id of the expense to correct (from record_expense or list_expenses). Preferred whenever you have it.'),
  match: z
    .object({
      date: z.string().optional().describe('YYYY-MM-DD; omit for today.'),
      category: z.enum(EXPENSE_CATEGORIES).optional(),
    })
    .optional()
    .describe('Use only without entryId: finds the single expense on that date (and category). If several match, nothing is changed and candidates are returned.'),
  newAmountRupees: z
    .number()
    .positive()
    .max(MAX_ENTRY_RUPEES)
    .refine(hasAtMostTwoDecimals, 'newAmountRupees can have at most 2 decimal places')
    .optional()
    .describe('Corrected amount in rupees, exactly as the farmer stated it.'),
  newCategory: z.enum(EXPENSE_CATEGORIES).optional(),
  newNote: z.string().max(200).optional().describe('Replacement note. An empty string removes the note.'),
  reason: z.string().trim().max(200).optional().describe('Why it was corrected, in the farmer\'s words, e.g. "it was 900 not 800".'),
};

const snapshotView = z.object({
  amountPaise: z.number().int(),
  amountDisplay: z.string(),
  category: z.enum(EXPENSE_CATEGORIES),
  note: z.string().optional(),
});

const outputSchema = {
  status: z
    .enum(['corrected', 'no_change', 'needs_clarification'])
    .describe('needs_clarification: several entries matched, nothing was changed; ask the farmer which candidate they mean.'),
  entry: entryViewSchema.optional().describe('The expense after the correction.'),
  before: snapshotView.optional(),
  after: snapshotView.optional(),
  changedFields: z.array(z.enum(['amountPaise', 'category', 'note'])).optional(),
  correctionId: z.string().optional().describe('Id of the stored audit record.'),
  candidates: z.array(entryViewSchema).optional(),
};

const toSnapshotView = (s: ExpenseSnapshot) => ({
  amountPaise: s.amountPaise,
  amountDisplay: formatPaise(s.amountPaise),
  category: s.category,
  ...(s.note ? { note: s.note } : {}),
});

function describeChanges(before: ExpenseSnapshot, after: ExpenseSnapshot, fields: CorrectableField[]): string {
  return fields
    .map((f) => {
      if (f === 'amountPaise') return `amount ${formatPaise(before.amountPaise)} → ${formatPaise(after.amountPaise)}`;
      if (f === 'category') return `category ${before.category} → ${after.category}`;
      return after.note ? `note "${before.note ?? ''}" → "${after.note}"` : 'note removed';
    })
    .join(', ');
}

export function registerCorrectEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'correct_entry',
    {
      title: 'Correct an expense',
      description:
        'Corrects the amount, category or note of an expense already recorded, e.g. after "No, it was ₹900". ' +
        'Pass entryId when known. Keeps an audit record of the values before and after. ' +
        'If the result is needs_clarification, show the candidates and ask the farmer which one; do not pick yourself.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('correct_entry', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        if (args.entryId && args.match) throw new ToolUserError('give either entryId or match, not both');
        if (!args.entryId && !args.match) throw new ToolUserError('say which expense to correct: give entryId, or match with a date/category');
        if (args.newAmountRupees === undefined && args.newCategory === undefined && args.newNote === undefined) {
          throw new ToolUserError('nothing to correct: give newAmountRupees, newCategory and/or newNote');
        }

        // 1. Find the one expense to correct.
        let target: ExpenseEntry | undefined;
        if (args.entryId) {
          const parsed = parseEntryId(args.entryId);
          if (!parsed) throw new ToolUserError(`"${args.entryId}" is not a valid entry id`);
          if (parsed.kind !== 'expense') throw new ToolUserError('only expenses can be corrected; activities cannot be edited yet');
          target = await deps.ledger.getExpense(farmId, args.entryId);
          if (!target) throw new ToolUserError(`no expense with id ${args.entryId} was found`);
        } else {
          const date = resolveEntryDate(args.match!.date, todayInFarmTimeZone(deps.now()));
          const category = args.match!.category;
          const matches = await deps.ledger.getAllExpenses({ farmId, from: date, to: date, category });
          const what = `${category ? `${category} ` : ''}expense${matches.length === 1 ? '' : 's'} on ${date}`;
          if (matches.length === 0) throw new ToolUserError(`no ${what} found to correct`);
          if (matches.length > 1) {
            const candidates = matches.sort((a, b) => b.entryId.localeCompare(a.entryId)).map(toEntryView);
            const list = candidates.map((c, i) => `${i + 1}) ${c.amountDisplay} ${c.category}${c.note ? ` "${c.note}"` : ''}`).join('; ');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Nothing changed: ${matches.length} ${what} match. Ask the farmer which one: ${list}.\n${JSON.stringify({ status: 'needs_clarification', candidates })}`,
                },
              ],
              structuredContent: { status: 'needs_clarification' as const, candidates },
            };
          }
          target = matches[0]!;
        }

        // 2. Work out the new values; ignore "changes" to the same value.
        const before = snapshotOf(target);
        const { after, changedFields } = applyChanges(before, {
          amountPaise: args.newAmountRupees === undefined ? undefined : rupeesToPaise(args.newAmountRupees),
          category: args.newCategory,
          note: args.newNote,
        });
        if (changedFields.length === 0) {
          const entry = toEntryView(target);
          return {
            content: [{ type: 'text' as const, text: `No change needed: the expense already has those values.\n${JSON.stringify({ status: 'no_change', entry })}` }],
            structuredContent: { status: 'no_change' as const, entry },
          };
        }

        // 3. Save atomically with the audit record, only if nobody changed the entry since we read it.
        let saved;
        try {
          saved = await deps.ledger.correctExpense({
            farmId,
            entryId: target.entryId,
            expectedVersion: target.version,
            before,
            after,
            changedFields,
            reason: args.reason || undefined,
          });
        } catch (error) {
          if (error instanceof ConcurrentModificationError || error instanceof EntryNotFoundError) throw new ToolUserError(error.message);
          throw error;
        }

        const structured = {
          status: 'corrected' as const,
          entry: toEntryView(saved.entry),
          before: toSnapshotView(before),
          after: toSnapshotView(after),
          changedFields,
          correctionId: saved.correction.correctionId,
        };
        const text = `Corrected the ${before.category} expense on ${target.date}: ${describeChanges(before, after, changedFields)}.`;
        return {
          content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }],
          structuredContent: structured,
        };
      }),
  );
}
