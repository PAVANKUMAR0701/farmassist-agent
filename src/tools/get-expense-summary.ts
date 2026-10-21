import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { summarizeExpenses } from '../domain/expense-summary.js';
import { TooManyEntriesError } from '../repositories/ledger-repository.js';
import { formatPaise } from '../shared/money.js';
import { todayInFarmTimeZone } from '../shared/time.js';
import { categoryFilterInput, dateRangeInput, rangeOutputSchema, resolveDateRange, type ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

const inputSchema = {
  ...dateRangeInput,
  category: categoryFilterInput,
  groupBy: z.enum(['category', 'day', 'month']).default('category').describe('Break the total down by category, by day, or by month (each month also by category).'),
};

const totalSchema = z.object({
  key: z.string().describe('Category name, YYYY-MM-DD date or YYYY-MM month'),
  totalPaise: z.number().int(),
  totalDisplay: z.string(),
  entryCount: z.number().int(),
});
const groupSchema = totalSchema.extend({ categories: z.array(totalSchema).optional().describe('Month groups: that month by category.') });

const outputSchema = {
  range: rangeOutputSchema,
  category: z.string().optional(),
  groupBy: z.enum(['category', 'day', 'month']),
  totalPaise: z.number().int(),
  totalDisplay: z.string(),
  entryCount: z.number().int(),
  groups: z.array(groupSchema),
  calculatedBy: z.literal('server').describe('Totals are added up by FarmAssist code from saved entries, not estimated.'),
};

export function registerGetExpenseSummary(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_expense_summary',
    {
      title: 'Expense totals',
      description:
        'Returns verified expense totals for a period (default: this month), optionally for one category, broken down by category or day. ' +
        'Use this for any "how much did I spend" question. Repeat the returned totalDisplay exactly; never add, estimate or round amounts yourself.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('get_expense_summary', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const range = resolveDateRange(args, todayInFarmTimeZone(deps.now()));

        let entries;
        try {
          entries = await deps.ledger.getAllExpenses({ farmId, from: range.from, to: range.to, category: args.category });
        } catch (error) {
          if (error instanceof TooManyEntriesError) throw new ToolUserError(error.message);
          throw error;
        }

        const summary = summarizeExpenses(entries, args.groupBy);
        const structured = {
          range,
          ...(args.category ? { category: args.category } : {}),
          groupBy: args.groupBy,
          totalPaise: summary.totalPaise,
          totalDisplay: formatPaise(summary.totalPaise),
          entryCount: summary.entryCount,
          groups: summary.groups.map((g) => ({
            ...g,
            totalDisplay: formatPaise(g.totalPaise),
            ...(g.categories ? { categories: g.categories.map((c) => ({ ...c, totalDisplay: formatPaise(c.totalPaise) })) } : {}),
          })),
          calculatedBy: 'server' as const,
        };
        const what = args.category ? `on ${args.category}` : 'in total';
        const entriesWord = summary.entryCount === 1 ? 'entry' : 'entries';
        const text =
          summary.entryCount === 0
            ? `No expenses ${args.category ? `on ${args.category} ` : ''}recorded from ${range.from} to ${range.to}. Total: ${structured.totalDisplay}.`
            : `Spent ${structured.totalDisplay} ${what} from ${range.from} to ${range.to} (${summary.entryCount} ${entriesWord}).` +
              (args.groupBy !== 'month' ? '' : ` By month: ${structured.groups.map((g) => `${g.key.replaceAll('_', ' ')} ${g.totalDisplay}`).join(', ')}.`);
        return {
          content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }],
          structuredContent: structured,
        };
      }),
  );
}
