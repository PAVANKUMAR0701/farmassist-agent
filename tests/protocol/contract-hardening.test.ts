import { describe, expect, it } from 'vitest';
import { callTool, makeTestConfig, postJson, TEST_FARM_ID } from '../helpers/mcp-http.js';

const V = { 'MCP-Protocol-Version': '2025-11-25' };

describe('tenant identity comes only from the token', () => {
  it('ignores a farmId smuggled into tool arguments', async () => {
    const { config, ledger } = makeTestConfig();
    const r = await callTool(config, 'record_expense', { amountRupees: 100, category: 'feed', farmId: 'someone-elses-farm' });
    expect(r.isError).toBeFalsy();

    const own = await ledger.getAllExpenses({ farmId: TEST_FARM_ID, from: '2026-10-14', to: '2026-10-14' });
    const other = await ledger.getAllExpenses({ farmId: 'someone-elses-farm', from: '2026-10-14', to: '2026-10-14' });
    expect(own).toHaveLength(1);
    expect(other).toHaveLength(0);
  });
});

describe('malformed tool arguments are rejected without writing anything', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['amount as a string', { amountRupees: '2500', category: 'feed' }],
    ['negative amount', { amountRupees: -5, category: 'feed' }],
    ['zero amount', { amountRupees: 0, category: 'feed' }],
    ['amount above ₹1 crore', { amountRupees: 10_000_001, category: 'feed' }],
    ['three decimal places', { amountRupees: 10.005, category: 'feed' }],
    ['missing category', { amountRupees: 100 }],
    ['unknown category', { amountRupees: 100, category: 'gold' }],
    ['note over 200 characters', { amountRupees: 100, category: 'feed', note: 'x'.repeat(201) }],
    ['impossible date', { amountRupees: 100, category: 'feed', date: '2026-02-30' }],
    ['future date', { amountRupees: 100, category: 'feed', date: '2026-10-15' }],
    ['date in another format', { amountRupees: 100, category: 'feed', date: '14/10/2026' }],
    ['clientRequestId with spaces', { amountRupees: 100, category: 'feed', clientRequestId: 'has spaces in it' }],
  ];

  it.each(bad)('record_expense: %s', async (_name, args) => {
    const { config, ledger } = makeTestConfig();
    const r = await callTool(config, 'record_expense', args);
    expect(r.isError).toBe(true);
    expect(await ledger.getAllExpenses({ farmId: TEST_FARM_ID, from: '2000-01-01', to: '2026-10-14' })).toHaveLength(0);
  });

  it('list_expenses rejects a limit above 50 and a range longer than 366 days', async () => {
    const { config } = makeTestConfig();
    expect((await callTool(config, 'list_expenses', { limit: 51 })).isError).toBe(true);
    expect((await callTool(config, 'list_expenses', { from: '2024-01-01', to: '2026-10-14' })).isError).toBe(true);
  });
});

describe('JSON-RPC envelope errors', () => {
  it('answers an unknown tool with an error, not a crash', async () => {
    const { config } = makeTestConfig();
    const res = await postJson(config, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drop_table', arguments: {} } }, V);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });

  it('answers an unknown method with JSON-RPC -32601', async () => {
    const { config } = makeTestConfig();
    const res = await postJson(config, { jsonrpc: '2.0', id: 1, method: 'farm/delete_everything' }, V);
    expect((await res.json()).error?.code).toBe(-32601);
  });

  it('rejects a body that is not a JSON-RPC message', async () => {
    const { config } = makeTestConfig();
    const res = await postJson(config, { hello: 'world' }, V);
    expect(res.status).toBe(400);
  });

  // Batching was removed in 2025-06-18 but older negotiated versions may still send it. The SDK answers each
  // message and caps a batch at 100, which bounds the work one HTTP request can cause.
  const recordCall = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'record_expense', arguments: { amountRupees: 1, category: 'feed' } } });
  const writtenToday = (ledger: ReturnType<typeof makeTestConfig>['ledger']) =>
    ledger.getAllExpenses({ farmId: TEST_FARM_ID, from: '2026-10-14', to: '2026-10-14' });

  it('answers each message of a small JSON-RPC batch', async () => {
    const { config, ledger } = makeTestConfig();
    const res = await postJson(config, [recordCall(1), recordCall(2)], V);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(2);
    expect(await writtenToday(ledger)).toHaveLength(2);
  });

  it('refuses a batch of more than 100 messages before running any of them', async () => {
    const { config, ledger } = makeTestConfig();
    const res = await postJson(config, Array.from({ length: 101 }, (_, i) => recordCall(i + 1)), V);
    expect(res.status).toBe(400);
    expect(await writtenToday(ledger)).toHaveLength(0);
  });
});
