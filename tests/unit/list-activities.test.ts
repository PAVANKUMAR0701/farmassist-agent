import { describe, expect, it } from 'vitest';
import { callTool, makeTestConfig } from '../helpers/mcp-http.js';

// Fixed clock: 2026-10-14 12:00 IST.
describe('list_activities', () => {
  it('lists this month newest first, filters by type, and counts everything in range', async () => {
    const { config } = makeTestConfig();
    const rows: Array<[string, string, string]> = [
      ['vaccination', 'brown cow', '2026-10-02'],
      ['milking', 'Lakshmi', '2026-10-10'],
      ['vaccination', 'Lakshmi', '2026-10-14'],
      ['irrigation', 'north field', '2026-09-30'], // last month
    ];
    for (const [activityType, animalOrField, date] of rows) {
      expect((await callTool(config, 'record_farm_activity', { activityType, animalOrField, date })).isError).toBeFalsy();
    }

    const all = await callTool(config, 'list_activities', {});
    expect(all.structuredContent).toMatchObject({ range: { from: '2026-10-01', to: '2026-10-14', label: 'this_month' }, totalCount: 3 });
    expect(all.structuredContent.items.map((a: { date: string }) => a.date)).toEqual(['2026-10-14', '2026-10-10', '2026-10-02']);

    const vaccinations = await callTool(config, 'list_activities', { activityType: 'vaccination', limit: 1 });
    expect(vaccinations.structuredContent).toMatchObject({ totalCount: 2, items: [{ animalOrField: 'Lakshmi', date: '2026-10-14' }] });
    expect(vaccinations.content[0]!.text).toContain('2 vaccination activities from 2026-10-01 to 2026-10-14 (showing the newest 1). Newest: 2026-10-14 vaccination for Lakshmi.');
  });

  it('rejects a limit above 100 and says clearly when nothing was recorded', async () => {
    const { config } = makeTestConfig();
    expect((await callTool(config, 'list_activities', { limit: 101 })).isError).toBe(true);
    const empty = await callTool(config, 'list_activities', { period: 'last_month' });
    expect(empty.content[0]!.text).toContain('No activities recorded from 2026-09-01 to 2026-09-30.');
  });
});
