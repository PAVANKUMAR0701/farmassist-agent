import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { ACTIVITY_TYPES, type FarmActivity } from '../domain/activity.js';
import { IdempotencyConflictError } from '../repositories/ledger-repository.js';
import { todayInFarmTimeZone } from '../shared/time.js';
import { clientRequestIdInput, entryDateInput, idempotencyFor, resolveEntryDate, type ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

const inputSchema = {
  activityType: z
    .enum(ACTIVITY_TYPES)
    .describe('What was done. Use "other" (with a note) only when none of the listed activities fits.'),
  animalOrField: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe('Which animal or field, in the farmer\'s words, e.g. "brown cow", "Lakshmi", "north field".'),
  note: z.string().trim().max(200).optional().describe('Details in the farmer\'s words, e.g. "FMD vaccine", "12 litres".'),
  date: entryDateInput,
  clientRequestId: clientRequestIdInput,
};

export const activityViewSchema = z.object({
  entryId: z.string(),
  date: z.string(),
  activityType: z.enum(ACTIVITY_TYPES),
  animalOrField: z.string().optional(),
  note: z.string().optional(),
});

export function toActivityView(activity: FarmActivity): z.infer<typeof activityViewSchema> {
  return {
    entryId: activity.entryId,
    date: activity.date,
    activityType: activity.activityType,
    ...(activity.animalOrField ? { animalOrField: activity.animalOrField } : {}),
    ...(activity.note ? { note: activity.note } : {}),
  };
}

const outputSchema = {
  activity: activityViewSchema,
  duplicate: z.boolean().describe('True if this request was already recorded earlier; nothing new was saved.'),
};

export function registerRecordFarmActivity(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'record_farm_activity',
    {
      title: 'Record a farm activity',
      description:
        'Saves a farm activity such as milking, vaccination, sowing, harvesting or irrigation, optionally for a named animal or field. ' +
        'Do not use for money spent (use record_expense).',
      inputSchema,
      outputSchema: outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('record_farm_activity', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const date = resolveEntryDate(args.date, todayInFarmTimeZone(deps.now()));
        const animalOrField = args.animalOrField || undefined;
        const note = args.note || undefined;
        if (args.activityType === 'other' && !note) throw new ToolUserError('a note describing the activity is required when activityType is "other"');

        const idempotency = idempotencyFor(args.clientRequestId, 'activity', [
          args.activityType,
          animalOrField ?? null,
          note ?? null,
          args.date ?? null,
        ]);

        let result;
        try {
          result = await deps.ledger.createActivity(
            { farmId, date, activityType: args.activityType, ...(animalOrField ? { animalOrField } : {}), ...(note ? { note } : {}) },
            idempotency,
          );
        } catch (error) {
          if (error instanceof IdempotencyConflictError) throw new ToolUserError(error.message);
          throw error;
        }

        const structured = { activity: toActivityView(result.entry), duplicate: result.duplicate };
        const { activity } = structured;
        // "other" means nothing to a farmer; say what was actually recorded.
        const kind = activity.activityType === 'other' && activity.note ? `"${activity.note}"` : activity.activityType;
        const what = `${kind}${activity.animalOrField ? ` for ${activity.animalOrField}` : ''} on ${activity.date}`;
        const summary = result.duplicate ? `Already recorded earlier (no duplicate created): ${what}.` : `Recorded ${what}.`;
        return {
          content: [{ type: 'text' as const, text: `${summary}\n${JSON.stringify(structured)}` }],
          structuredContent: structured,
        };
      }),
  );
}
