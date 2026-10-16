import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { EXPENSE_CATEGORIES } from '../domain/expense.js';
import { IdempotencyConflictError } from '../repositories/ledger-repository.js';
import { hasAtMostTwoDecimals, MAX_ENTRY_RUPEES, rupeesToPaise } from '../shared/money.js';
import { todayInFarmTimeZone } from '../shared/time.js';
import {
  clientRequestIdInput,
  entryDateInput,
  entryViewSchema,
  idempotencyFor,
  resolveEntryDate,
  toEntryView,
  type ToolDeps,
} from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

const inputSchema = {
  amountRupees: z
    .number()
    .positive()
    .max(MAX_ENTRY_RUPEES)
    .refine(hasAtMostTwoDecimals, 'amountRupees can have at most 2 decimal places')
    .describe('Amount spent in Indian rupees, e.g. 2500 or 149.50. Must be stated by the farmer; never guess it.'),
  category: z
    .enum(EXPENSE_CATEGORIES)
    .describe('Expense category. If the farmer\'s words do not clearly fit one category, ask them instead of guessing.'),
  note: z.string().trim().max(200).optional().describe('Short description in the farmer\'s words, e.g. "cattle feed, 2 bags".'),
  date: entryDateInput,
  clientRequestId: clientRequestIdInput,
};

const outputSchema = {
  entry: entryViewSchema,
  duplicate: z.boolean().describe('True if this request was already recorded earlier; nothing new was saved.'),
};

export function registerRecordExpense(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'record_expense',
    {
      title: 'Record a farm expense',
      description:
        'Saves one farm expense (money spent) to the farmer\'s ledger. Use only when the farmer clearly states an amount of money and what it was for. ' +
        'Not for events without money, such as a birth or naming an animal (use register_animal or record_farm_activity). ' +
        'Returns the saved entry with its entryId (needed to correct it later).',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('record_expense', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const date = resolveEntryDate(args.date, todayInFarmTimeZone(deps.now()));
        const amountPaise = rupeesToPaise(args.amountRupees);
        const note = args.note || undefined;
        // "other" alone says nothing about where the money went; the farmer has to be asked.
        if (args.category === 'other' && !note) throw new ToolUserError('a note saying what the money was for is required when category is "other"; ask the farmer what it was');
        const idempotency = idempotencyFor(args.clientRequestId, 'expense', [amountPaise, args.category, note ?? null, args.date ?? null]);

        let result;
        try {
          result = await deps.ledger.createExpense({ farmId, date, category: args.category, amountPaise, ...(note ? { note } : {}) }, idempotency);
        } catch (error) {
          if (error instanceof IdempotencyConflictError) throw new ToolUserError(error.message);
          throw error;
        }

        const structured = { entry: toEntryView(result.entry), duplicate: result.duplicate };
        const { entry } = structured;
        const summary = result.duplicate
          ? `Already recorded earlier (no duplicate created): ${entry.amountDisplay} on ${entry.category} for ${entry.date}.`
          : `Recorded ${entry.amountDisplay} on ${entry.category} for ${entry.date}.`;
        return {
          content: [{ type: 'text' as const, text: `${summary}\n${JSON.stringify(structured)}` }],
          structuredContent: structured,
        };
      }),
  );
}
