/**
 * Compares Bedrock models for weekly_insights narration: the same retry loop and number guard as the tool,
 * on realistic weeks. Reports how often the guard passes on the first try and after one retry, latency,
 * and style problems (markdown, dates, advice, length).
 *
 *   BEDROCK_AWS_PROFILE=M80PocBedrockKeys npm run narration-eval -- --runs=2 apac.amazon.nova-lite-v1:0 apac.amazon.nova-micro-v1:0
 */
import { checkMeaning } from '../src/domain/meaning-guard.js';
import { checkNumbers } from '../src/domain/number-guard.js';
import { computeWeeklyFacts, type WeeklyFacts } from '../src/domain/weekly-facts.js';
import type { ExpenseCategory, ExpenseEntry } from '../src/domain/expense.js';
import type { ActivityType, FarmActivity } from '../src/domain/activity.js';
import { BedrockInsightNarrator } from '../src/services/insight-narrator.js';
import { createBedrockClientFromEnv } from '../src/services/bedrock-client.js';

const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 1);
const models = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (models.length === 0) {
  console.error('Usage: npm run narration-eval -- [--runs=2] <modelId> [<modelId> ...]');
  process.exit(1);
}

let n = 0;
const expense = (date: string, category: ExpenseCategory, rupees: number): ExpenseEntry => ({
  entryId: `exp_${date.replaceAll('-', '')}_01J${String(++n).padStart(23, '0')}`,
  farmId: 'f',
  date,
  category,
  amountPaise: Math.round(rupees * 100),
  createdAt: '',
  updatedAt: '',
  version: 1,
});
const activity = (date: string, activityType: ActivityType): FarmActivity => ({
  entryId: `act_${date.replaceAll('-', '')}_01J${String(++n).padStart(23, '0')}`,
  farmId: 'f',
  date,
  activityType,
  createdAt: '',
  updatedAt: '',
  version: 1,
});
const week = { from: '2026-10-10', to: '2026-10-16' };
const previousWeek = { from: '2026-10-03', to: '2026-10-09' };
const facts = (expenses: ExpenseEntry[], previousExpenses: ExpenseEntry[], activities: FarmActivity[] = []) =>
  computeWeeklyFacts({ week, previousWeek, dayCount: 7, expenses, previousExpenses, activities });

const WEEKS: Array<[string, WeeklyFacts]> = [
  ['spending up, feed dominant', facts([expense('2026-10-11', 'feed', 2500), expense('2026-10-13', 'feed', 1800), expense('2026-10-14', 'medicine', 650.5)], [expense('2026-10-05', 'feed', 2200)])],
  ['spending down, several categories', facts([expense('2026-10-10', 'fuel', 1200), expense('2026-10-12', 'labour', 900), expense('2026-10-15', 'seed', 300)], [expense('2026-10-04', 'equipment', 4500), expense('2026-10-06', 'feed', 1500)])],
  ['no previous week', facts([expense('2026-10-11', 'fodder', 700), expense('2026-10-16', 'feed', 2400)], [])],
  ['with activities', facts([expense('2026-10-12', 'medicine', 800), expense('2026-10-13', 'feed', 2500)], [expense('2026-10-05', 'feed', 2500), expense('2026-10-06', 'medicine', 800)], [activity('2026-10-12', 'vaccination'), activity('2026-10-14', 'milking'), activity('2026-10-15', 'milking')])],
  ['one big purchase', facts([expense('2026-10-14', 'equipment', 85000), expense('2026-10-15', 'fuel', 450)], [expense('2026-10-07', 'fuel', 500)])],
];

const STYLE: Array<[string, RegExp]> = [
  ['markdown', /\*\*|^\s*[-*] |^#/m],
  ['a date', /\b\d{4}-\d{2}-\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i],
  ['advice', /\b(should|recommend|suggest|consider|try to|make sure)\b/i],
];

const client = createBedrockClientFromEnv(process.env, 'farmassist-narration-eval');
for (const modelId of models) {
  const narrator = new BedrockInsightNarrator(client, modelId);
  let firstTry = 0;
  let afterRetry = 0;
  let styleIssues = 0;
  const latencies: number[] = [];
  console.log(`\n=== ${modelId}`);
  for (let run = 1; run <= runs; run++) {
    for (const [name, f] of WEEKS) {
      const started = Date.now();
      // The same two guards and feedback as weekly_insights.
      const judge = (t: string) => {
        const numbers = checkNumbers(t, f);
        const meaning = numbers.ok ? checkMeaning(t, f) : { ok: true, problems: [] };
        return { ok: numbers.ok && meaning.ok, unsupported: [...numbers.unsupported, ...meaning.problems], feedback: numbers.ok ? `${meaning.problems.join('; ')}.` : `it contained numbers that are not in the facts: ${numbers.unsupported.join(', ')}.` };
      };
      let text = await narrator.narrate(f);
      let check = judge(text);
      const passedFirst = check.ok;
      if (!check.ok) {
        text = await narrator.narrate(f, check.feedback);
        check = judge(text);
      }
      latencies.push(Date.now() - started);
      if (passedFirst) firstTry++;
      if (check.ok) afterRetry++;
      const style = STYLE.filter(([, re]) => re.test(text)).map(([s]) => s);
      const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
      if (sentences > 4) style.push(`${sentences} sentences`);
      if (style.length) styleIssues++;
      console.log(
        `${check.ok ? (passedFirst ? 'PASS ' : 'PASS2') : 'FAIL '} [run ${run}] ${name}${check.ok ? '' : ` unsupported ${JSON.stringify(check.unsupported)}`}${style.length ? ` style: ${style.join(', ')}` : ''}\n      ${text.replace(/\s+/g, ' ').slice(0, 260)}`,
      );
    }
  }
  latencies.sort((a, b) => a - b);
  const total = WEEKS.length * runs;
  console.log(`\n${modelId}: guard passed ${firstTry}/${total} first try, ${afterRetry}/${total} after one retry; style issues in ${styleIssues}/${total}; median ${latencies[Math.floor(latencies.length / 2)]} ms`);
}
