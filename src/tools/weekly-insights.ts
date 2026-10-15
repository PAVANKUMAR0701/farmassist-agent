import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { farmIdFromAuth } from '../auth/bearer.js';
import { checkNumbers } from '../domain/number-guard.js';
import { computeWeeklyFacts, templateNarrative, type WeeklyFacts } from '../domain/weekly-facts.js';
import { TooManyEntriesError } from '../repositories/ledger-repository.js';
import { addDays, isValidIsoDate, todayInFarmTimeZone } from '../shared/time.js';
import type { ToolDeps } from './shared.js';
import { runTool, ToolUserError } from './tool-errors.js';

/** Bedrock gets this many tries to produce narration that passes the number guard. */
export const MAX_NARRATION_ATTEMPTS = 2;
const DAYS = 7;

const inputSchema = {
  weekEnding: z.string().optional().describe('Last day of the 7-day period as YYYY-MM-DD in India time. Omit for the 7 days ending today.'),
};

const outputSchema = {
  facts: z.record(z.string(), z.unknown()).describe('Every number in the insight, calculated by FarmAssist code.'),
  narrative: z.string().describe('Plain-language explanation. Every number in it has been checked against facts.'),
  narrationSource: z.enum(['bedrock', 'template']),
  guard: z.object({
    status: z.enum(['passed', 'replaced', 'not_needed', 'bedrock_unavailable', 'bedrock_not_configured']),
    attempts: z.number().int(),
    rejectedNumbers: z.array(z.string()).describe('Numbers in rejected Bedrock drafts that were not in the facts.'),
  }),
  modelId: z.string().optional(),
};

type Narration = { narrative: string; narrationSource: 'bedrock' | 'template'; guard: z.infer<typeof outputSchema.guard>; modelId?: string };

/** Asks Bedrock for narration and keeps it only if every number passes the guard; otherwise uses the template. */
async function narrate(facts: WeeklyFacts, deps: ToolDeps): Promise<Narration> {
  const fallback = (status: Narration['guard']['status'], attempts = 0, rejectedNumbers: string[] = []): Narration => ({
    narrative: templateNarrative(facts),
    narrationSource: 'template',
    guard: { status, attempts, rejectedNumbers },
    ...(deps.narrator ? { modelId: deps.narrator.modelId } : {}),
  });

  if (!facts.sufficientData) return fallback('not_needed');
  if (!deps.narrator) return fallback('bedrock_not_configured');

  const rejectedNumbers: string[] = [];
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= MAX_NARRATION_ATTEMPTS; attempt++) {
    let draft: string;
    try {
      draft = await deps.narrator.narrate(facts, feedback);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', tool: 'weekly_insights', message: 'Bedrock call failed', error: error instanceof Error ? error.name : String(error) }));
      return fallback('bedrock_unavailable', attempt, rejectedNumbers);
    }
    const check = checkNumbers(draft, facts);
    if (check.ok) {
      return { narrative: draft, narrationSource: 'bedrock', guard: { status: 'passed', attempts: attempt, rejectedNumbers }, modelId: deps.narrator.modelId };
    }
    rejectedNumbers.push(...check.unsupported);
    // Log how many numbers failed, not the numbers themselves (they are farm data).
    console.warn(JSON.stringify({ level: 'warn', tool: 'weekly_insights', message: 'Narration rejected by number guard', attempt, unsupportedCount: check.unsupported.length }));
    feedback = `it contained numbers that are not in the facts: ${check.unsupported.join(', ')}.`;
  }
  return fallback('replaced', MAX_NARRATION_ATTEMPTS, rejectedNumbers);
}

export function registerWeeklyInsights(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'weekly_insights',
    {
      title: 'Weekly insights',
      description:
        'Explains the last 7 days of farm records (default: ending today): total spending, biggest categories, change from the previous 7 days and activities. ' +
        'All numbers are calculated by FarmAssist and every number in the narrative is verified. Show the narrative as it is; do not add numbers or advice.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runTool('weekly_insights', async () => {
        const farmId = farmIdFromAuth(extra.authInfo);
        const today = todayInFarmTimeZone(deps.now());
        const to = args.weekEnding ?? today;
        if (!isValidIsoDate(to)) throw new ToolUserError(`weekEnding "${to}" is not a real calendar date in YYYY-MM-DD format`);
        if (to > today) throw new ToolUserError(`weekEnding ${to} is in the future (today in India is ${today})`);
        const week = { from: addDays(to, -(DAYS - 1)), to };
        const previousWeek = { from: addDays(week.from, -DAYS), to: addDays(week.from, -1) };

        let expenses, previousExpenses, activities;
        try {
          [expenses, previousExpenses, activities] = await Promise.all([
            deps.ledger.getAllExpenses({ farmId, ...week }),
            deps.ledger.getAllExpenses({ farmId, ...previousWeek }),
            deps.ledger.getActivities({ farmId, ...week }),
          ]);
        } catch (error) {
          if (error instanceof TooManyEntriesError) throw new ToolUserError(error.message);
          throw error;
        }

        const facts = computeWeeklyFacts({ week, previousWeek, dayCount: DAYS, expenses, previousExpenses, activities });
        const narration = await narrate(facts, deps);
        const structured = { facts: facts as unknown as Record<string, unknown>, ...narration };
        return {
          content: [{ type: 'text' as const, text: `${narration.narrative}\n${JSON.stringify(structured)}` }],
          structuredContent: structured,
        };
      }),
  );
}
