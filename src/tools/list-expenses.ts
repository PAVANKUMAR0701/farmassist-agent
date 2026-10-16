import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { InvalidCursorError } from '../repositories/cursor.js';
import { todayInFarmTimeZone } from '../shared/time.js';
import { categoryFilterInput, dateRangeInput, entryViewSchema, rangeOutputSchema, resolveDateRange, toEntryView, type ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

const inputSchema = {
  ...dateRangeInput,
  category: categoryFilterInput,
  limit: z.number().int().min(1).max(50).default(20).describe('Maximum entries to return (1-50).'),
  cursor: z.string().max(1000).optional().describe('nextCursor from a previous call with the same filters, to get the next page.'),
};

const outputSchema = {
  range: rangeOutputSchema,
  category: z.string().optional(),
  items: z.array(entryViewSchema),
  nextCursor: z.string().optional().describe('Present when more entries exist. Pass it back unchanged to get them.'),
};

export function registerListExpenses(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_expenses',
    {
      title: 'List farm expenses',
      description:
        'Lists individual saved expenses, newest first, for a period (default: this month) and optional category. ' +
        'Use this to show or find entries (e.g. to correct one). For totals, use get_expense_summary instead of adding amounts yourself.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('list_expenses', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const range = resolveDateRange(args, todayInFarmTimeZone(deps.now()));

        let page;
        try {
          page = await deps.ledger.listExpenses({
            farmId,
            from: range.from,
            to: range.to,
            category: args.category,
            limit: args.limit,
            cursor: args.cursor,
          });
        } catch (error) {
          if (error instanceof InvalidCursorError) throw new ToolUserError(error.message);
          throw error;
        }

        const structured = {
          range,
          ...(args.category ? { category: args.category } : {}),
          items: page.items.map(toEntryView),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
        const what = args.category ? `${args.category} expenses` : 'expenses';
        const summary =
          structured.items.length === 0
            ? `No ${what} recorded from ${range.from} to ${range.to}.`
            : `${structured.items.length} ${what} from ${range.from} to ${range.to}${page.nextCursor ? ' (more available)' : ''}. Newest: ${structured.items
                .slice(0, 5)
                .map((e) => `${e.date} ${e.amountDisplay} on ${e.category}${e.note ? ` (${e.note})` : ''}`)
                .join('; ')}.`;
        return {
          content: [{ type: 'text' as const, text: `${summary}\n${JSON.stringify(structured)}` }],
          structuredContent: structured,
        };
      }),
  );
}
