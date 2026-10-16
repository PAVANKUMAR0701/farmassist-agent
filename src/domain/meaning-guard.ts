/**
 * The meaning guard: the number guard checks that every number in a narrative exists in the facts, but not
 * what it is attached to. Measured on Nova Lite and Micro (scripts/narration-eval.ts), real drafts passed the
 * number guard and were still wrong:
 *   "your farm spent ₹85,450 on equipment"         (the week's total; equipment was ₹85,000)
 *   "Labour and seeds together cost ₹1,200"         (a sum the model worked out itself)
 *   "spending on feed was 125% higher"              (the overall change, not feed's)
 *   "There's no earlier week to compare with"       (there was one)
 * These checks bind amounts and percentages to the category written next to them, and keep comparisons with
 * the previous week consistent with the facts.
 */
import type { WeeklyFacts } from './weekly-facts.js';

const CATEGORY_WORDS: Record<string, string> = {
  feed: 'feed',
  fodder: 'fodder',
  medicine: 'medicine',
  medicines: 'medicine',
  labour: 'labour',
  labor: 'labour',
  fuel: 'fuel',
  diesel: 'fuel',
  equipment: 'equipment',
  seed: 'seed',
  seeds: 'seed',
};
const CATEGORY = Object.keys(CATEGORY_WORDS).join('|');
const MONEY = String.raw`₹\s?(\d[\d,]*(?:\.\d+)?)`;
const toPaise = (raw: string) => Math.round(Number(raw.replaceAll(',', '')) * 100);
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface MeaningResult {
  ok: boolean;
  problems: string[];
}

export function checkMeaning(text: string, facts: WeeklyFacts): MeaningResult {
  const problems: string[] = [];
  const byCategory = new Map(facts.byCategory.map((c) => [c.category, c]));

  const checkAmount = (word: string, raw: string) => {
    const category = CATEGORY_WORDS[word.toLowerCase()];
    if (!category) return;
    const actual = byCategory.get(category);
    const written = toPaise(raw);
    if (!actual) problems.push(`it gives ₹${raw} for ${category}, but nothing was spent on ${category} this week`);
    else if (actual.totalPaise !== written) problems.push(`it gives ₹${raw} for ${category}, but ${category} was ${rupees(actual.totalPaise)}`);
  };

  // "₹85,450 on equipment", "₹4,300.00, went to feed", "₹800 spent on medicine"
  for (const m of text.matchAll(new RegExp(String.raw`${MONEY},?\s+(?:(?:was|were|is)\s+)?(?:(?:spent|used|paid|going|went)\s+)?(?:on|for|to)\s+(?:the\s+|your\s+)?(${CATEGORY})\b`, 'gi'))) {
    checkAmount(m[2]!, m[1]!);
  }
  // "Fuel was the biggest expense at ₹1,200", "seeds together cost ₹1,200". Never across "and"/"while"/a comma:
  // in "₹2,500 on feed and ₹800 on medicine" the ₹800 belongs to medicine, not feed.
  // Each category word looks ahead on its own, so "Labour and seeds ... ₹1,200" still checks "seeds".
  for (const word of text.matchAll(new RegExp(String.raw`\b(${CATEGORY})\b`, 'gi'))) {
    const after = new RegExp(String.raw`^([^.₹%,;]{0,40}?)${MONEY}`).exec(text.slice(word.index! + word[0].length));
    if (after && !/\b(and|while|but|with|whereas)\b/i.test(after[1]!)) checkAmount(word[1]!, after[2]!);
  }
  // "Feed made up 76%", "spending on feed was 125% higher": a percentage next to a category is its share.
  for (const m of text.matchAll(new RegExp(String.raw`\b(${CATEGORY})\b[^.₹%]{0,50}?(\d+(?:\.\d+)?)\s?%`, 'gi'))) {
    const category = CATEGORY_WORDS[m[1]!.toLowerCase()]!;
    const actual = byCategory.get(category);
    if (!actual || actual.sharePercent !== Number(m[2])) {
      problems.push(`it gives ${m[2]}% for ${category}, but ${category}'s share of the week's spending is ${actual ? `${actual.sharePercent}%` : 'nothing'} (other percentages are about the whole week)`);
    }
  }

  // Comparisons with the previous week must match the facts.
  const deniesComparison = /\bno (earlier|previous|prior|last) week\b|\bnothing to compare\b|\bfirst recorded week\b|\bno (earlier|previous) (records|data)\b/i.test(text);
  const compares = /\b(more|less|higher|lower) than (last|the previous|previous) week\b|\bcompared (to|with) (last|the previous|previous) week\b|\bthan last week'?s?\b/i.test(text);
  if (facts.change && deniesComparison) problems.push('it says there is no earlier week to compare with, but there is (see "change")');
  if (!facts.change && compares) problems.push('it compares with last week, but there are no records for last week');
  if (facts.sufficientData && /\b(too few|not enough|very few) (records|data|expenses|entries)\b|\bhard to (see|tell) (a|any)\b/i.test(text)) {
    problems.push('it says there are too few records to see a pattern, but there are enough (sufficientData is true)');
  }
  if (facts.change?.direction === 'up' && /\b(less than last week|lower than last week|decrease[ds]?|went down|dropped|fell)\b/i.test(text)) {
    problems.push('it says spending went down, but it went up');
  }
  if (facts.change?.direction === 'down' && /\b(more than last week|higher than last week|increase[ds]?|went up|rose)\b/i.test(text)) {
    problems.push('it says spending went up, but it went down');
  }
  return { ok: problems.length === 0, problems };
}
