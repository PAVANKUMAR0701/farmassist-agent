import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { summarizeExpenses } from '../domain/expense-summary.js';
import { TooManyEntriesError } from '../repositories/ledger-repository.js';
import { formatPaise } from '../shared/money.js';
import { isValidIsoDate, todayInFarmTimeZone } from '../shared/time.js';
import { activityViewSchema, toActivityView } from './record-farm-activity.js';
import { entryViewSchema, toEntryView, type ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

const inputSchema = {
  date: z.string().optional().describe('Day to summarise as YYYY-MM-DD in India time. Omit for today.'),
};

const outputSchema = {
  date: z.string(),
  expenseTotalPaise: z.number().int(),
  expenseTotalDisplay: z.string(),
  expenseCount: z.number().int(),
  byCategory: z.array(z.object({ category: z.string(), totalPaise: z.number().int(), totalDisplay: z.string(), entryCount: z.number().int() })),
  topCategory: z.string().optional().describe('Category with the most money spent that day; absent when nothing was spent.'),
  expenses: z.array(entryViewSchema).describe('In recording order.'),
  activities: z.array(activityViewSchema).describe('In recording order.'),
  calculatedBy: z.literal('server').describe('Totals are added up by FarmAssist code from saved entries, not estimated.'),
};

export function registerGetDailySummary(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_daily_summary',
    {
      title: 'Daily summary',
      description:
        'Returns everything recorded for one day (default: today): verified expense total, spending by category, and every expense and activity. ' +
        'Use this for "what did I do today" or "what happened yesterday". Repeat the returned amounts exactly; never add them up yourself.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('get_daily_summary', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const date = args.date ?? today;
        if (!isValidIsoDate(date)) throw new ToolUserError(`date "${date}" is not a real calendar date in YYYY-MM-DD format`);
        if (date > today) throw new ToolUserError(`date ${date} is in the future (today in India is ${today})`);

        let expenses, activities;
        try {
          [expenses, activities] = await Promise.all([
            deps.ledger.getAllExpenses({ farmId, from: date, to: date }),
            deps.ledger.getActivities({ farmId, from: date, to: date }),
          ]);
        } catch (error) {
          if (error instanceof TooManyEntriesError) throw new ToolUserError(error.message);
          throw error;
        }
        // Same-day entry ids share the date prefix and end in a ULID, so sorting by id gives recording order.
        expenses.sort((a, b) => a.entryId.localeCompare(b.entryId));

        const summary = summarizeExpenses(expenses, 'category');
        const structured = {
          date,
          expenseTotalPaise: summary.totalPaise,
          expenseTotalDisplay: formatPaise(summary.totalPaise),
          expenseCount: summary.entryCount,
          byCategory: summary.groups.map((g) => ({
            category: g.key,
            totalPaise: g.totalPaise,
            totalDisplay: formatPaise(g.totalPaise),
            entryCount: g.entryCount,
          })),
          ...(summary.groups[0] ? { topCategory: summary.groups[0].key } : {}),
          expenses: expenses.map(toEntryView),
          activities: activities.map(toActivityView),
          calculatedBy: 'server' as const,
        };

        const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
        const spent =
          summary.entryCount === 0
            ? 'No expenses'
            : `Spent ${structured.expenseTotalDisplay} (${count(summary.entryCount, 'expense', 'expenses')}, most on ${structured.topCategory})`;
        const done = activities.length === 0 ? 'no activities' : count(activities.length, 'activity', 'activities');
        const text = `${date}: ${spent}; ${done} recorded.`;
        return {
          content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }],
          structuredContent: structured,
        };
      }),
  );
}
