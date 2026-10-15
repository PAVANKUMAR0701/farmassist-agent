/**
 * Raw HTTP protocol smoke test for a running FarmAssist MCP endpoint (local or deployed).
 * Uses plain fetch (no MCP SDK) so it checks the wire format exactly as a client sees it.
 *
 *   npm run smoke -- http://127.0.0.1:3000/mcp
 *
 * Reads the bearer token from FARMASSIST_API_TOKEN (or .env.local).
 */
import { existsSync } from 'node:fs';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const url = process.argv[2] ?? 'http://127.0.0.1:3000/mcp';
const token = process.env.FARMASSIST_API_TOKEN;
if (!token) {
  console.error('Set FARMASSIST_API_TOKEN (or create .env.local) before running the smoke test.');
  process.exit(1);
}

const VERSION = '2025-11-25';
const base = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: `Bearer ${token}`,
};
const afterInit = { ...base, 'MCP-Protocol-Version': VERSION };

interface Check {
  name: string;
  /** A function when the request depends on an earlier response (e.g. an entryId). */
  init: RequestInit | (() => RequestInit);
  expectStatus: number;
  /** Optional extra assertion on the parsed JSON body. */
  expectBody?: (body: any) => boolean;
}

/** Values captured from earlier responses. */
const state: { medicineEntryId?: string } = {};
const toolCall = (id: number, name: string, args: object): RequestInit => ({
  method: 'POST',
  headers: afterInit,
  body: rpc({ id, method: 'tools/call', params: { name, arguments: args } }),
});

const rpc = (body: object) => JSON.stringify({ jsonrpc: '2.0', ...body });
const runId = `smoke-${Date.now()}`;
const recordExpense = rpc({
  id: 7,
  method: 'tools/call',
  params: { name: 'record_expense', arguments: { amountRupees: 2500, category: 'feed', note: 'cattle feed (smoke test)', clientRequestId: runId } },
});

const checks: Check[] = [
  {
    name: 'initialize',
    init: {
      method: 'POST',
      headers: base,
      body: rpc({ id: 1, method: 'initialize', params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } }),
    },
    expectStatus: 200,
    expectBody: (b) => b.result?.protocolVersion === VERSION,
  },
  {
    name: 'notifications/initialized -> 202',
    init: { method: 'POST', headers: afterInit, body: rpc({ method: 'notifications/initialized' }) },
    expectStatus: 202,
  },
  {
    name: 'tools/list',
    init: { method: 'POST', headers: afterInit, body: rpc({ id: 2, method: 'tools/list' }) },
    expectStatus: 200,
    expectBody: (b) => b.result?.tools?.some((t: { name: string }) => t.name === 'record_expense'),
  },
  {
    name: 'tools/call record_expense',
    init: { method: 'POST', headers: afterInit, body: recordExpense },
    expectStatus: 200,
    expectBody: (b) => b.result?.structuredContent?.entry?.amountPaise === 250000 && b.result.structuredContent.duplicate === false,
  },
  {
    name: 'tools/call record_expense again (same clientRequestId) -> duplicate',
    init: { method: 'POST', headers: afterInit, body: recordExpense },
    expectStatus: 200,
    expectBody: (b) => b.result?.structuredContent?.duplicate === true,
  },
  {
    name: 'tools/call get_expense_summary (feed, this month) includes the ₹2,500',
    init: {
      method: 'POST',
      headers: afterInit,
      body: rpc({ id: 9, method: 'tools/call', params: { name: 'get_expense_summary', arguments: { period: 'this_month', category: 'feed' } } }),
    },
    expectStatus: 200,
    expectBody: (b) => b.result?.structuredContent?.calculatedBy === 'server' && b.result.structuredContent.totalPaise >= 250000,
  },
  {
    name: 'tools/call list_expenses returns the smoke-test entry',
    init: {
      method: 'POST',
      headers: afterInit,
      body: rpc({ id: 10, method: 'tools/call', params: { name: 'list_expenses', arguments: { period: 'today', category: 'feed', limit: 50 } } }),
    },
    expectStatus: 200,
    expectBody: (b) => b.result?.structuredContent?.items?.some((i: { note?: string }) => i.note === 'cattle feed (smoke test)'),
  },
  {
    name: 'tools/call record_farm_activity (vaccination, brown cow)',
    init: {
      method: 'POST',
      headers: afterInit,
      body: rpc({
        id: 11,
        method: 'tools/call',
        params: { name: 'record_farm_activity', arguments: { activityType: 'vaccination', animalOrField: 'brown cow', note: 'smoke test' } },
      }),
    },
    expectStatus: 200,
    expectBody: (b) => b.result?.structuredContent?.activity?.entryId?.startsWith('act_') && b.result.structuredContent.duplicate === false,
  },
  {
    name: 'tools/call record_expense ₹800 medicine',
    init: toolCall(12, 'record_expense', { amountRupees: 800, category: 'medicine', note: 'smoke test correction' }),
    expectStatus: 200,
    expectBody: (b) => {
      state.medicineEntryId = b.result?.structuredContent?.entry?.entryId;
      return b.result?.structuredContent?.entry?.amountPaise === 80000;
    },
  },
  {
    name: 'tools/call correct_entry ₹800 -> ₹900 (before/after)',
    init: () => toolCall(13, 'correct_entry', { entryId: state.medicineEntryId, newAmountRupees: 900, reason: 'smoke test' }),
    expectStatus: 200,
    expectBody: (b) => {
      const s = b.result?.structuredContent;
      return s?.status === 'corrected' && s.before.amountPaise === 80000 && s.after.amountPaise === 90000;
    },
  },
  {
    name: 'tools/call get_daily_summary (today) includes the corrected ₹900 and the vaccination',
    init: toolCall(14, 'get_daily_summary', {}),
    expectStatus: 200,
    expectBody: (b) => {
      const s = b.result?.structuredContent;
      return (
        s?.calculatedBy === 'server' &&
        s.expenses.some((e: { entryId: string; amountPaise: number }) => e.entryId === state.medicineEntryId && e.amountPaise === 90000) &&
        s.activities.some((a: { activityType: string }) => a.activityType === 'vaccination')
      );
    },
  },
  {
    name: 'tools/call weekly_insights returns verified facts and a guarded narrative',
    init: toolCall(15, 'weekly_insights', {}),
    expectStatus: 200,
    expectBody: (b) => {
      const s = b.result?.structuredContent;
      return s?.facts?.totalPaise >= 250000 && typeof s.narrative === 'string' && ['passed', 'replaced', 'bedrock_unavailable', 'bedrock_not_configured'].includes(s.guard?.status);
    },
  },
  {
    name: 'tools/call record_expense invalid category -> isError',
    init: {
      method: 'POST',
      headers: afterInit,
      body: rpc({ id: 8, method: 'tools/call', params: { name: 'record_expense', arguments: { amountRupees: 100, category: 'snacks' } } }),
    },
    expectStatus: 200,
    expectBody: (b) => b.result?.isError === true,
  },
  {
    name: 'missing bearer token -> 401',
    init: { method: 'POST', headers: { ...afterInit, Authorization: '' }, body: rpc({ id: 3, method: 'tools/list' }) },
    expectStatus: 401,
  },
  { name: 'GET -> 405', init: { method: 'GET', headers: { Accept: 'text/event-stream' } }, expectStatus: 405 },
  { name: 'DELETE -> 405', init: { method: 'DELETE' }, expectStatus: 405 },
  {
    name: 'bad Origin -> 403',
    init: { method: 'POST', headers: { ...base, Origin: 'https://evil.example' }, body: rpc({ id: 4, method: 'tools/list' }) },
    expectStatus: 403,
  },
  {
    name: 'unsupported MCP-Protocol-Version -> 400',
    init: { method: 'POST', headers: { ...base, 'MCP-Protocol-Version': '1999-01-01' }, body: rpc({ id: 5, method: 'tools/list' }) },
    expectStatus: 400,
  },
  {
    name: 'Accept without text/event-stream -> 406',
    init: { method: 'POST', headers: { ...base, Accept: 'application/json' }, body: rpc({ id: 6, method: 'tools/list' }) },
    expectStatus: 406,
  },
];

let failures = 0;
console.log(`MCP protocol smoke test against ${url}\n`);
for (const check of checks) {
  const res = await fetch(url, typeof check.init === 'function' ? check.init() : check.init);
  const text = await res.text();
  let ok = res.status === check.expectStatus;
  if (ok && check.expectBody) {
    try {
      ok = check.expectBody(JSON.parse(text));
    } catch {
      ok = false;
    }
  }
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.name}  (HTTP ${res.status}, expected ${check.expectStatus})`);
  if (text) console.log(`      ${text.length > 220 ? `${text.slice(0, 220)}…` : text}`);
}
console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
