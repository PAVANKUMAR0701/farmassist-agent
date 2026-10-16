/**
 * Compares Bedrock models as the FarmAssist agent's brain, against a real MCP endpoint.
 * Each case checks the tool the model chose, its arguments, and the reply (no invented numbers, no leaked
 * reasoning). Writes are dated January 2025 so they stay out of "today" and "this month" during a demo.
 *
 *   npm run agent-eval -- [--runs=3] apac.amazon.nova-lite-v1:0 apac.amazon.nova-micro-v1:0
 *
 * Needs FARMASSIST_MCP_URL, FARMASSIST_API_TOKEN and Bedrock credentials (e.g. BEDROCK_AWS_PROFILE).
 */
import { existsSync } from 'node:fs';
import { FarmAgent, type AgentTurn } from '../src/agent/agent.js';
import { FarmMcpClient } from '../src/agent/mcp-client.js';
import { BedrockAgentModel } from '../src/agent/model.js';
import { createBedrockClientFromEnv } from '../src/services/bedrock-client.js';
import { todayInFarmTimeZone } from '../src/shared/time.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const url = process.env.FARMASSIST_MCP_URL;
const token = process.env.FARMASSIST_API_TOKEN;
const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 1);
const modelIds = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!url || !token || modelIds.length === 0) {
  console.error('Usage: npm run agent-eval -- <modelId> [<modelId> ...]   (FARMASSIST_MCP_URL and FARMASSIST_API_TOKEN must be set)');
  process.exit(1);
}

const D = '2025-01-22';
const thisMonthStart = `${todayInFarmTimeZone().slice(0, 7)}-01`;
const WRITES = new Set(['record_expense', 'record_farm_activity', 'correct_entry']);

type Check = (turn: AgentTurn, earlier: AgentTurn[]) => string | undefined; // undefined = pass, else reason
interface Case {
  name: string;
  /** Messages sent in one conversation; only the last turn is checked (earlier ones set up context). */
  messages: string[];
  check: Check;
}

const call = (turn: AgentTurn, name: string) => turn.toolCalls.find((c) => c.name === name && !c.result.isError);
const expectCall = (turn: AgentTurn, name: string, args: Record<string, unknown>): string | undefined => {
  const c = call(turn, name);
  const tried = JSON.stringify(turn.toolCalls.map((t) => [t.name, t.args, t.result.isError ? 'ERROR' : 'ok']));
  if (!c) return `expected ${name}, got ${tried}`;
  for (const [key, value] of Object.entries(args)) {
    if (c.args[key] !== value) return `${name}.${key} = ${JSON.stringify(c.args[key])}, expected ${JSON.stringify(value)}; calls ${tried}`;
  }
  return undefined;
};

const cases: Case[] = [
  { name: 'record expense', messages: [`I spent 2500 rupees on cattle feed on ${D}`], check: (t) => expectCall(t, 'record_expense', { amountRupees: 2500, category: 'feed', date: D }) },
  {
    name: 'correct by id ("no, it was 2400")',
    messages: [`I spent 2500 rupees on cattle feed on ${D}`, 'no, it was 2400'],
    check: (t, [first]) => {
      const recorded = call(first!, 'record_expense')?.result.structured?.entry as { entryId?: string } | undefined;
      return expectCall(t, 'correct_entry', { entryId: recorded?.entryId, newAmountRupees: 2400 });
    },
  },
  { name: 'fuel from one word', messages: [`Diesel 1200 on ${D}`], check: (t) => expectCall(t, 'record_expense', { amountRupees: 1200, category: 'fuel', date: D }) },
  { name: 'vet visit is medicine', messages: [`Paid the vet 650 for Lakshmi's medicine on ${D}`], check: (t) => expectCall(t, 'record_expense', { amountRupees: 650, category: 'medicine', date: D }) },
  {
    name: 'activity with animal',
    messages: [`vaccinated the brown cow on ${D}`],
    check: (t) => expectCall(t, 'record_farm_activity', { activityType: 'vaccination', date: D }) ?? (/brown cow/i.test(String(call(t, 'record_farm_activity')!.args.animalOrField)) ? undefined : 'animalOrField is not "brown cow"'),
  },
  {
    // Live bug 2026-10-16: the model tried to edit the activity (refused) and then claimed it was updated.
    name: 'new detail about an animal is recorded, not claimed',
    messages: [`New calf born to Lakshmi on ${D}`, `Lakshmi's calf born on ${D} is named Seetha`],
    check: (t) => {
      if (t.claimCheck) return 'claimed a change the server refused (reply replaced)';
      const added = call(t, 'record_farm_activity');
      return added && /seetha/i.test(`${added.args.note ?? ''} ${added.args.animalOrField ?? ''}`)
        ? undefined
        : `expected a new activity mentioning Seetha, got ${JSON.stringify(t.toolCalls.map((c) => [c.name, c.args, c.result.isError ? 'ERROR' : 'ok']))}`;
    },
  },
  {
    name: 'Hinglish expense',
    messages: [`${D} ko 300 rupaye ka diesel liya`],
    check: (t) => expectCall(t, 'record_expense', { amountRupees: 300, category: 'fuel', date: D }),
  },
  {
    name: 'asks when category is missing (no write)',
    messages: ['I spent 700'],
    check: (t) => {
      const writes = t.toolCalls.filter((c) => WRITES.has(c.name));
      return writes.length > 0 ? `wrote without a category: ${writes.map((w) => JSON.stringify(w.args)).join(' ')}` : t.reply.includes('?') ? undefined : 'did not ask a question';
    },
  },
  {
    name: 'feed this month',
    messages: ['How much did I spend on feed this month?'],
    check: (t) => {
      const c = call(t, 'get_expense_summary');
      if (!c) return `expected get_expense_summary, got ${t.toolCalls.map((x) => x.name).join(', ') || 'no tool'}`;
      if (c.args.category !== 'feed') return `category = ${JSON.stringify(c.args.category)}`;
      return c.args.period === 'this_month' || c.args.from === thisMonthStart ? undefined : `range ${JSON.stringify(c.args)}`;
    },
  },
  {
    name: 'one day\'s spending',
    messages: [`what did I spend on ${D}?`],
    // Any read limited to that day answers it: the daily summary, a summary or a list with from = to = that day.
    check: (t) =>
      call(t, 'get_daily_summary')?.args.date === D || ['get_expense_summary', 'list_expenses'].some((n) => call(t, n)?.args.from === D && call(t, n)?.args.to === D)
        ? undefined
        : `got ${JSON.stringify(t.toolCalls.map((c) => [c.name, c.args]))}`,
  },
  { name: 'list a month', messages: ['show my expenses for January 2025'], check: (t) => expectCall(t, 'list_expenses', { from: '2025-01-01', to: '2025-01-31' }) },
  {
    name: 'weekly insights (this week, not a guessed year)',
    messages: ['how was my week?'],
    check: (t) => {
      const c = call(t, 'weekly_insights');
      if (!c) return `got ${t.toolCalls.map((x) => x.name).join(', ') || 'no tool'}`;
      return c.args.weekEnding === undefined || c.args.weekEnding === todayInFarmTimeZone() ? undefined : `weekEnding = ${JSON.stringify(c.args.weekEnding)}`;
    },
  },
];

const bedrock = createBedrockClientFromEnv(process.env, 'farmassist-agent-eval');
const summary: string[] = [];

/** Markdown that a voice reply must not contain: bold, bullets, headings, numbered lists. */
const MARKDOWN = /\*\*|^\s*[-*] |\s[-*] \*\*|^#|\n\s*\d+\. /m;

for (const modelId of modelIds) {
  const tools = new FarmMcpClient({ url, token });
  console.log(`\n=== ${modelId}`);
  const passes = new Map<string, number>();
  const latencies: number[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const testCase of cases) {
      const agent = new FarmAgent({ tools, model: new BedrockAgentModel(bedrock, modelId) });
      const turns: AgentTurn[] = [];
      let ms = 0;
      for (const message of testCase.messages) {
        const started = Date.now();
        turns.push(await agent.handle(message));
        ms = Date.now() - started;
      }
      latencies.push(ms);
      const turn = turns.at(-1)!;
      const problem =
        (turn.modelError ? `model failed: ${turn.modelError.slice(0, 120)}` : undefined) ??
        testCase.check(turn, turns.slice(0, -1)) ??
        (/<thinking|\[entryId|exp_\d|act_\d/i.test(turn.reply) ? 'reply leaks reasoning or ids' : undefined) ??
        (turn.numberCheck === 'replaced' ? `reply had unverified numbers ${JSON.stringify(turn.unverifiedNumbers)} (replaced)` : undefined) ??
        (MARKDOWN.test(turn.reply) ? 'reply uses markdown (bad for voice)' : undefined);
      if (!problem) passes.set(testCase.name, (passes.get(testCase.name) ?? 0) + 1);
      console.log(`${problem ? 'FAIL' : 'PASS'}  [run ${run}] ${testCase.name}  (${ms} ms)${problem ? `\n      ${problem}` : ''}\n      reply: ${turn.reply.slice(0, 160)}`);
    }
  }
  latencies.sort((a, b) => a - b);
  const total = [...passes.values()].reduce((a, b) => a + b, 0);
  const weak = cases.filter((c) => (passes.get(c.name) ?? 0) < runs).map((c) => `${c.name} ${passes.get(c.name) ?? 0}/${runs}`);
  summary.push(
    `${modelId}: ${total}/${cases.length * runs} passed over ${runs} run(s), median ${latencies[Math.floor(latencies.length / 2)]} ms, max ${latencies.at(-1)} ms` +
      (weak.length ? `\n    not always right: ${weak.join('; ')}` : ''),
  );
  await tools.close();
}

console.log(`\n${summary.join('\n')}`);
