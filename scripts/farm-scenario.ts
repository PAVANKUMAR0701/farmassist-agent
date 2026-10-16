/**
 * End-to-end farm scenario through the real agent and MCP tools, with in-memory storage.
 * Runs in voice mode: every change is read back and confirmed with "yes", as on the phone.
 * After the conversation it checks the stored records themselves, not just the replies.
 *
 *   AGENT_MODEL_ID=apac.amazon.nova-lite-v1:0 BEDROCK_AWS_PROFILE=M80PocBedrockKeys npm run farm-scenario [-- --runs=2]
 */
import { FarmAgent } from '../src/agent/agent.js';
import { FarmMcpClient } from '../src/agent/mcp-client.js';
import { createAgentModelFromEnv } from '../src/agent/model.js';
import { handleMcpRequest } from '../src/mcp/http.js';
import { InMemoryLedgerRepository } from '../src/repositories/memory-ledger-repository.js';
import { InMemoryRecordStore } from '../src/repositories/record-store.js';
import { todayInFarmTimeZone } from '../src/shared/time.js';

const model = createAgentModelFromEnv();
if (!model) {
  console.error('Set AGENT_MODEL_ID (and Bedrock credentials) to run the scenario.');
  process.exit(1);
}
const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 1);
const today = todayInFarmTimeZone();

const SCRIPT = [
  'I have 4 cows: Lakshmi, Maya, Geeta and Rita. Lakshmi is HF and was born on 2022-07-10',
  'Rename Rita to Sita',
  'Lakshmi gave 8 litres in the morning and 7 litres in the evening',
  'Maya gave 6.5 litres today',
  'How much milk did I get today?',
  'Spent 1200 on diesel',
  'I planted paddy in the north field on 2026-06-20, 2 acres, with 50 kg of seed',
  'I sowed ragi in the east plot on 2026-07-05, 1 acre, 10 kg seed',
  'Harvested 30 quintal of paddy from the north field, that was the final harvest',
  'Got 8 quintal of ragi from the east plot',
  'Compare my paddy and ragi: how much seed did I use and how much did I get?',
  'Lakshmi is insured with United India until 2026-11-05, premium 1850 rupees',
  'Remind me to deworm the calves on 2026-11-01',
  "What's coming up?",
  'How many cows do I have and what are their names?',
  'Maya was sold today',
  'How many cows do I have now?',
];

const checks: Array<[string, (s: Snapshot) => boolean]> = [
  ['4 cows registered, Rita renamed to Sita', (s) => sameSet(s.animals.map((a) => a.name), ['Lakshmi', 'Maya', 'Geeta', 'Sita'])],
  ['Lakshmi is HF, born 2022-07-10', (s) => s.animals.some((a) => a.name === 'Lakshmi' && /hf/i.test(a.breed ?? '') && a.birthDate === '2022-07-10')],
  ['Maya marked sold, the others active', (s) => s.animals.filter((a) => a.status === 'active').length === 3 && s.animals.some((a) => a.name === 'Maya' && a.status === 'sold')],
  ['milk today: 8 + 7 + 6.5 = 21.5 L', (s) => s.milkMl === 21500],
  ['diesel expense ₹1,200 as fuel', (s) => s.expenses.some((e) => e.category === 'fuel' && e.amountPaise === 120000)],
  ['paddy: 2 acres, 50 kg seed, 30 quintal, closed', (s) => s.crops.some((c) => c.crop === 'paddy' && c.areaHundredths === 200 && c.seedGrams === 50000 && c.harvestedGrams === 3_000_000 && c.status === 'harvested')],
  ['ragi: 1 acre, 10 kg seed, 8 quintal', (s) => s.crops.some((c) => c.crop === 'ragi' && c.areaHundredths === 100 && c.seedGrams === 10000 && c.harvestedGrams === 800_000)],
  ['insurance for Lakshmi until 2026-11-05, premium ₹1,850', (s) => s.insurance.some((p) => p.animalName === 'Lakshmi' && p.endDate === '2026-11-05' && p.premiumPaise === 185000)],
  ['reminder to deworm on 2026-11-01', (s) => s.reminders.some((r) => /deworm/i.test(r.title) && r.dueDate === '2026-11-01')],
];

interface Snapshot {
  animals: Array<{ name?: string; breed?: string; birthDate?: string; status: string }>;
  milkMl: number;
  expenses: Array<{ category: string; amountPaise: number }>;
  crops: Array<{ crop: string; areaHundredths?: number; seedGrams?: number; status: string; harvestedGrams: number }>;
  insurance: Array<{ animalName?: string; endDate: string; premiumPaise?: number }>;
  reminders: Array<{ title: string; dueDate: string }>;
}
const sameSet = (a: Array<string | undefined>, b: string[]) => a.length === b.length && b.every((x) => a.includes(x));

let totalPassed = 0;
for (let run = 1; run <= runs; run++) {
  const token = 'scenario-token-0123456789abcdef0123456789';
  const ledger = new InMemoryLedgerRepository();
  const records = new InMemoryRecordStore();
  const config = { allowedOrigins: [], apiTokens: [{ token, farmId: 'scenario-farm', clientId: 'scenario' }], deps: { ledger, records, now: () => new Date() } };
  const tools = new FarmMcpClient({ url: 'http://in-process/mcp', token, fetch: (u, i) => handleMcpRequest(new Request(u, i), config) });
  const agent = new FarmAgent({ tools, model });
  console.log(`\n=== run ${run}`);

  for (const message of SCRIPT) {
    let turn = await agent.handle(message, { confirmWrites: true });
    const how = (t: typeof turn) =>
      `[${t.mode}${t.confirmation ? ', read-back' : ''}${t.modelError ? `, model failed: ${t.modelError.slice(0, 60)}` : ''}${t.numberCheck === 'replaced' ? `, numbers replaced ${JSON.stringify(t.unverifiedNumbers)}` : ''}]`;
    console.log(`> ${message}\n  ${how(turn)} ${turn.reply.slice(0, 300)}`);
    for (let guard = 0; turn.confirmation && guard < 3; guard++) {
      turn = await agent.handle('yes', { confirmWrites: true });
      console.log(`> yes\n  ${turn.reply.slice(0, 300)}`);
    }
    const refused = turn.toolCalls.filter((c) => c.result.isError);
    if (refused.length) console.log(`  [refused: ${refused.map((c) => `${c.name}: ${c.result.text.slice(0, 120)}`).join(' | ')}]`);
  }

  const farmId = 'scenario-farm';
  const [animals, milk, crops, harvests, insurance, reminders, expenses] = await Promise.all([
    records.list<any>(farmId, 'animal'),
    records.list<any>(farmId, 'milk', { from: today, to: today }),
    records.list<any>(farmId, 'crop'),
    records.list<any>(farmId, 'harvest'),
    records.list<any>(farmId, 'insurance'),
    records.list<any>(farmId, 'reminder'),
    ledger.getAllExpenses({ farmId, from: today, to: today }),
  ]);
  const snapshot: Snapshot = {
    animals: animals.map((a) => a.data),
    milkMl: milk.reduce((n, m) => n + m.data.millilitres, 0),
    expenses,
    crops: crops.map((c) => ({ ...c.data, harvestedGrams: harvests.filter((h) => h.data.cropId === c.id).reduce((n, h) => n + h.data.grams, 0) })),
    insurance: insurance.map((p) => p.data),
    reminders: reminders.map((r) => r.data),
  };
  console.log('\n  Stored records:');
  for (const [name, check] of checks) {
    const passed = check(snapshot);
    if (passed) totalPassed++;
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}`);
  }
  if (checks.some(([, c]) => !c(snapshot))) console.log(`  snapshot: ${JSON.stringify(snapshot).slice(0, 1500)}`);
}
console.log(`\n${totalPassed}/${checks.length * runs} record checks passed over ${runs} run(s)`);
