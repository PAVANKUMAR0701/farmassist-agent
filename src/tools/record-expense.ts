import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { EXPENSE_CATEGORIES } from '../domain/expense.js';
import { IdempotencyConflictError, type LedgerRepository } from '../repositories/ledger-repository.js';
import { formatPaise, hasAtMostTwoDecimals, MAX_ENTRY_RUPEES, rupeesToPaise } from '../shared/money.js';
import { isValidIsoDate, todayInFarmTimeZone } from '../shared/time.js';
import { runTool, ToolUserError } from './tool-errors.js';

export interface ToolDeps {
  ledger: LedgerRepository;
  now: () => Date;
}

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
  date: z
    .string()
    .optional()
    .describe('Date of the expense as YYYY-MM-DD in India time. Omit for today.'),
  clientRequestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, 'clientRequestId must be 8-64 letters, digits, "-" or "_"')
    .optional()
    .describe('Unique id for this request. Retrying with the same id never creates a second entry.'),
};

const entryOutput = z.object({
  entryId: z.string(),
  date: z.string(),
  category: z.enum(EXPENSE_CATEGORIES),
  amountPaise: z.number().int(),
  amountDisplay: z.string(),
  note: z.string().optional(),
});

const outputSchema = {
  entry: entryOutput,
  duplicate: z.boolean().describe('True if this request was already recorded earlier; nothing new was saved.'),
};

export function registerRecordExpense(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'record_expense',
    {
      title: 'Record a farm expense',
      description:
        'Saves one farm expense to the farmer\'s ledger. Use only when the farmer clearly states an amount and what it was for. ' +
        'Returns the saved entry with its entryId (needed to correct it later).',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('record_expense', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const date = args.date ?? today;
        if (!isValidIsoDate(date)) throw new ToolUserError(`date "${date}" is not a real calendar date in YYYY-MM-DD format`);
        if (date > today) throw new ToolUserError(`date ${date} is in the future (today in India is ${today})`);

        const amountPaise = rupeesToPaise(args.amountRupees);
        const note = args.note || undefined;
        const idempotency = args.clientRequestId
          ? {
              clientRequestId: args.clientRequestId,
              // Fingerprint the request as sent (date as given, not as resolved) so a retry after midnight still matches.
              fingerprint: createHash('sha256')
                .update(JSON.stringify([amountPaise, args.category, note ?? null, args.date ?? null]))
                .digest('hex'),
            }
          : undefined;

        let result;
        try {
          result = await deps.ledger.createExpense({ farmId, date, category: args.category, amountPaise, ...(note ? { note } : {}) }, idempotency);
        } catch (error) {
          if (error instanceof IdempotencyConflictError) throw new ToolUserError(error.message);
          throw error;
        }

        const { entry, duplicate } = result;
        const structured = {
          entry: {
            entryId: entry.entryId,
            date: entry.date,
            category: entry.category,
            amountPaise: entry.amountPaise,
            amountDisplay: formatPaise(entry.amountPaise),
            ...(entry.note ? { note: entry.note } : {}),
          },
          duplicate,
        };
        const summary = duplicate
          ? `Already recorded earlier (no duplicate created): ${structured.entry.amountDisplay} on ${entry.category} for ${entry.date}.`
          : `Recorded ${structured.entry.amountDisplay} on ${entry.category} for ${entry.date}.`;
        return {
          content: [{ type: 'text' as const, text: `${summary}\n${JSON.stringify(structured)}` }],
          structuredContent: structured,
        };
      }),
  );
}
