import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FARM_TIME_ZONE, todayInFarmTimeZone } from '../shared/time.js';
import { registerGetExpenseSummary } from '../tools/get-expense-summary.js';
import { registerListExpenses } from '../tools/list-expenses.js';
import { registerRecordExpense } from '../tools/record-expense.js';
import type { ToolDeps } from '../tools/shared.js';

export const SERVER_NAME = 'farmassist-agent';
export const SERVER_VERSION = '0.1.0';

export type FarmServerDeps = ToolDeps;

/**
 * Builds a fresh MCP server with all FarmAssist tools registered.
 * A new instance is created for every HTTP request because the server runs stateless (see http.ts);
 * the dependencies (database client etc.) are created once and shared.
 */
export function createFarmServer(deps: FarmServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'FarmAssist records farm expenses and activities for a small Indian farm. ' +
        'All money totals are calculated by the server; never compute or invent totals yourself.',
    },
  );

  server.registerTool(
    'health_check',
    {
      title: 'Health check',
      description: 'Confirms the FarmAssist server is reachable and returns today\'s date in the farm time zone.',
      outputSchema: {
        status: z.literal('ok'),
        serverVersion: z.string(),
        farmTimeZone: z.string(),
        todayInFarmTimeZone: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const result = {
        status: 'ok' as const,
        serverVersion: SERVER_VERSION,
        farmTimeZone: FARM_TIME_ZONE,
        todayInFarmTimeZone: todayInFarmTimeZone(deps.now()),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  registerRecordExpense(server, deps);
  registerListExpenses(server, deps);
  registerGetExpenseSummary(server, deps);

  return server;
}
