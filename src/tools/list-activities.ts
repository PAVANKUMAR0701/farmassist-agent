import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { ACTIVITY_TYPES } from '../domain/activity.js';
import { TooManyEntriesError } from '../repositories/ledger-repository.js';
import { todayInFarmTimeZone } from '../shared/time.js';
import { activityViewSchema, toActivityView } from './record-farm-activity.js';
import { dateRangeInput, rangeOutputSchema, resolveDateRange, type ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

const inputSchema = {
  ...dateRangeInput,
  activityType: z.enum(ACTIVITY_TYPES).optional().describe('Only include this kind of activity.'),
  limit: z.number().int().min(1).max(100).default(50).describe('Maximum activities to return (1-100), newest first.'),
};

const outputSchema = {
  range: rangeOutputSchema,
  activityType: z.string().optional(),
  items: z.array(activityViewSchema),
  totalCount: z.number().int().describe('How many activities match in the whole range (items may hold fewer).'),
};

export function registerListActivities(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_activities',
    {
      title: 'List farm activities',
      description:
        'Lists recorded farm activities (milking, vaccination, sowing, harvesting, irrigation, other), newest first, ' +
        'for a period (default: this month) and optional activity type. Use this for questions like "when did I last vaccinate the brown cow".',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('list_activities', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const range = resolveDateRange(args, todayInFarmTimeZone(deps.now()));

        let activities;
        try {
          activities = await deps.ledger.getActivities({ farmId, from: range.from, to: range.to });
        } catch (error) {
          if (error instanceof TooManyEntriesError) throw new ToolUserError(error.message);
          throw error;
        }
        // Entry ids are date + ULID, so sorting them descending gives newest first.
        const matching = activities
          .filter((a) => !args.activityType || a.activityType === args.activityType)
          .sort((a, b) => b.entryId.localeCompare(a.entryId));

        const structured = {
          range,
          ...(args.activityType ? { activityType: args.activityType } : {}),
          items: matching.slice(0, args.limit).map(toActivityView),
          totalCount: matching.length,
        };
        const what = `${args.activityType ? `${args.activityType} ` : ''}${matching.length === 1 ? 'activity' : 'activities'}`;
        const shown = structured.items.length < matching.length ? ` (showing the newest ${structured.items.length})` : '';
        const text =
          matching.length === 0
            ? `No ${args.activityType ? `${args.activityType} ` : ''}activities recorded from ${range.from} to ${range.to}.`
            : `${matching.length} ${what} from ${range.from} to ${range.to}${shown}.`;
        return {
          content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(structured)}` }],
          structuredContent: structured,
        };
      }),
  );
}
