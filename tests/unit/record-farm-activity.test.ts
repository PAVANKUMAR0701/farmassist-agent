import { describe, expect, it } from 'vitest';
import { callTool, makeTestConfig, TEST_FARM_ID } from '../helpers/mcp-http.js';

describe('record_farm_activity tool', () => {
  it('records a vaccination for a named cow, dated today in IST', async () => {
    const { config, ledger } = makeTestConfig();
    const r = await callTool(config, 'record_farm_activity', {
      activityType: 'vaccination',
      animalOrField: 'brown cow',
      note: 'FMD vaccine',
    });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      duplicate: false,
      activity: { activityType: 'vaccination', animalOrField: 'brown cow', note: 'FMD vaccine', date: '2026-10-14' },
    });
    expect(r.structuredContent.activity.entryId).toMatch(/^act_20261014_[0-9A-Z]{26}$/);
    expect(r.content[0]!.text).toContain('Recorded vaccination for brown cow on 2026-10-14.');

    const stored = [...ledger.activities.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ farmId: TEST_FARM_ID, version: 1 });
    expect(ledger.expenses.size).toBe(0); // activities never create money entries
  });

  it('works without an animal or field', async () => {
    const { config } = makeTestConfig();
    const r = await callTool(config, 'record_farm_activity', { activityType: 'irrigation' });
    expect(r.structuredContent.activity).toEqual({ entryId: expect.any(String), date: '2026-10-14', activityType: 'irrigation' });
  });

  it('uses the IST date just after IST midnight', async () => {
    const { config } = makeTestConfig(new Date('2026-10-14T19:00:00Z')); // 00:30 IST on 15 Oct
    const r = await callTool(config, 'record_farm_activity', { activityType: 'milking' });
    expect(r.structuredContent.activity.date).toBe('2026-10-15');
  });

  it('does not duplicate on retry with the same clientRequestId', async () => {
    const { config, ledger } = makeTestConfig();
    const args = { activityType: 'sowing', animalOrField: 'north field', clientRequestId: 'act-req-0001' };
    const first = await callTool(config, 'record_farm_activity', args);
    const retry = await callTool(config, 'record_farm_activity', args);
    expect(retry.structuredContent.duplicate).toBe(true);
    expect(retry.structuredContent.activity.entryId).toBe(first.structuredContent.activity.entryId);
    expect(ledger.activities.size).toBe(1);
  });

  it('rejects a clientRequestId already used for an expense', async () => {
    const { config, ledger } = makeTestConfig();
    await callTool(config, 'record_expense', { amountRupees: 100, category: 'feed', clientRequestId: 'shared-id-0001' });
    const r = await callTool(config, 'record_farm_activity', { activityType: 'milking', clientRequestId: 'shared-id-0001' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('already used for a different request');
    expect(ledger.activities.size).toBe(0);
  });

  it.each([
    ['unknown type', { activityType: 'dancing' }],
    ['missing type', { animalOrField: 'brown cow' }],
    ['"other" without a note', { activityType: 'other' }],
    ['blank animal name', { activityType: 'milking', animalOrField: '   ' }],
    ['animal name too long', { activityType: 'milking', animalOrField: 'x'.repeat(61) }],
    ['future date', { activityType: 'milking', date: '2026-10-15' }],
    ['impossible date', { activityType: 'milking', date: '2026-02-30' }],
  ])('rejects %s and saves nothing', async (_label, args) => {
    const { config, ledger } = makeTestConfig();
    const r = await callTool(config, 'record_farm_activity', args);
    expect(r.isError).toBe(true);
    expect(ledger.activities.size).toBe(0);
  });

  it('accepts "other" when a note explains it', async () => {
    const { config } = makeTestConfig();
    const r = await callTool(config, 'record_farm_activity', { activityType: 'other', note: 'repaired the cattle shed roof' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toMatch(/^Recorded "repaired the cattle shed roof" on 2026-10-14\./);
  });
});
