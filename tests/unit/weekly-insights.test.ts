import { describe, expect, it, vi } from 'vitest';
import type { WeeklyFacts } from '../../src/domain/weekly-facts.js';
import type { InsightNarrator } from '../../src/services/insight-narrator.js';
import { callTool, makeTestConfig } from '../helpers/mcp-http.js';

/** A stand-in for Bedrock that returns scripted drafts, so no paid model calls run in tests. */
function scriptedNarrator(...drafts: Array<string | Error>) {
  const calls: Array<{ facts: WeeklyFacts; feedback?: string }> = [];
  const narrator: InsightNarrator = {
    modelId: 'test-model',
    async narrate(facts, feedback) {
      calls.push({ facts, ...(feedback ? { feedback } : {}) });
      const next = drafts.shift();
      if (next === undefined) throw new Error('no more scripted drafts');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { narrator, calls };
}

// Fixed clock: 2026-10-14 12:00 IST. Week = 2026-10-08..14, previous = 2026-10-01..07.
async function seed(config: ReturnType<typeof makeTestConfig>['config']) {
  const rows: Array<[number, string, string]> = [
    [2500, 'feed', '2026-10-14'],
    [900, 'medicine', '2026-10-14'],
    [150.25, 'feed', '2026-10-10'],
    [2000, 'feed', '2026-10-03'], // previous week
    [777, 'fuel', '2026-09-30'], // outside both weeks
  ];
  for (const [amountRupees, category, date] of rows) {
    expect((await callTool(config, 'record_expense', { amountRupees, category, date })).isError).toBeFalsy();
  }
  await callTool(config, 'record_farm_activity', { activityType: 'vaccination', animalOrField: 'brown cow' });
}

function setup(narrator?: InsightNarrator) {
  const made = makeTestConfig();
  if (narrator) made.config.deps.narrator = narrator;
  return made;
}

describe('weekly_insights tool', () => {
  it('passes Bedrock narration through when every number is in the facts', async () => {
    const draft = 'You spent ₹3,550.25 this week, mostly on feed (75%). That is ₹1,550.25 more than the week before.';
    const { narrator, calls } = scriptedNarrator(draft);
    const { config } = setup(narrator);
    await seed(config);

    const r = await callTool(config, 'weekly_insights', {});
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      narrative: draft,
      narrationSource: 'bedrock',
      guard: { status: 'passed', attempts: 1, rejectedNumbers: [] },
      modelId: 'test-model',
      facts: {
        week: { from: '2026-10-08', to: '2026-10-14' },
        totalPaise: 355025,
        previousTotalPaise: 200000,
        change: { direction: 'up', differencePaise: 155025, changePercent: 78 },
        activityCount: 1,
      },
    });
    // Bedrock only ever sees the computed facts, never raw entries or notes.
    expect(Object.keys(calls[0]!.facts)).not.toContain('expenses');
  });

  it('retries with feedback when the first draft invents a number, and keeps the corrected draft', async () => {
    const { narrator, calls } = scriptedNarrator(
      'You spent ₹4,000 this week.', // invented
      'You spent ₹3,550.25 this week.',
    );
    const { config } = setup(narrator);
    await seed(config);

    const r = await callTool(config, 'weekly_insights', {});
    expect(r.structuredContent).toMatchObject({
      narrative: 'You spent ₹3,550.25 this week.',
      narrationSource: 'bedrock',
      guard: { status: 'passed', attempts: 2, rejectedNumbers: ['₹4,000'] },
    });
    expect(calls[1]!.feedback).toContain('₹4,000');
  });

  it('never shows an unverified number: replaces narration that fails every attempt with the template', async () => {
    const { narrator } = scriptedNarrator('Feed costs jumped 40% to ₹9,999.', 'At this rate you will spend ₹14,201 this month.');
    const { config } = setup(narrator);
    await seed(config);

    const r = await callTool(config, 'weekly_insights', {});
    expect(r.structuredContent.narrationSource).toBe('template');
    expect(r.structuredContent.guard).toEqual({ status: 'replaced', attempts: 2, rejectedNumbers: ['40%', '₹9,999', '₹14,201'] });
    expect(r.structuredContent.narrative).toContain('you spent ₹3,550.25 across 3 expenses');
    for (const bad of ['9,999', '14,201', '40%']) expect(r.structuredContent.narrative).not.toContain(bad);
  });

  it('falls back to the template when Bedrock fails', async () => {
    const { narrator } = scriptedNarrator(Object.assign(new Error('Too many tokens per day'), { name: 'ThrottlingException' }));
    const { config } = setup(narrator);
    await seed(config);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await callTool(config, 'weekly_insights', {});
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ narrationSource: 'template', guard: { status: 'bedrock_unavailable', attempts: 1 } });
    errorLog.mockRestore();
  });

  it('works without Bedrock configured', async () => {
    const { config } = setup();
    await seed(config);
    const r = await callTool(config, 'weekly_insights', {});
    expect(r.structuredContent).toMatchObject({ narrationSource: 'template', guard: { status: 'bedrock_not_configured', attempts: 0 } });
  });

  it('does not call Bedrock when there is too little data', async () => {
    const { narrator, calls } = scriptedNarrator('should not be used');
    const { config } = setup(narrator);
    await callTool(config, 'record_expense', { amountRupees: 50, category: 'fuel' });

    const r = await callTool(config, 'weekly_insights', {});
    expect(calls).toHaveLength(0);
    expect(r.structuredContent).toMatchObject({ narrationSource: 'template', guard: { status: 'not_needed' }, facts: { sufficientData: false } });
    expect(r.structuredContent.narrative).toContain('too few records');
  });

  it('supports an explicit weekEnding and rejects future or invalid dates', async () => {
    const { config } = setup();
    await seed(config);
    const r = await callTool(config, 'weekly_insights', { weekEnding: '2026-10-07' });
    expect(r.structuredContent.facts).toMatchObject({ week: { from: '2026-10-01', to: '2026-10-07' }, totalPaise: 200000 });

    expect((await callTool(config, 'weekly_insights', { weekEnding: '2026-10-15' })).isError).toBe(true);
    expect((await callTool(config, 'weekly_insights', { weekEnding: '2026-13-01' })).isError).toBe(true);
  });
});
