/**
 * Raw HTTP protocol smoke test for a running FarmAssist MCP endpoint (local or deployed).
 * Uses plain fetch (no MCP SDK) so it checks the wire format exactly as a client sees it.
 *
 *   npx tsx scripts/protocol-smoke.ts http://127.0.0.1:3000/mcp
 */
const url = process.argv[2] ?? 'http://127.0.0.1:3000/mcp';
const VERSION = '2025-11-25';
const base = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

interface Check {
  name: string;
  init: RequestInit;
  expectStatus: number;
}

const rpc = (body: object) => JSON.stringify({ jsonrpc: '2.0', ...body });

const checks: Check[] = [
  {
    name: 'initialize',
    init: {
      method: 'POST',
      headers: base,
      body: rpc({ id: 1, method: 'initialize', params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } }),
    },
    expectStatus: 200,
  },
  {
    name: 'notifications/initialized -> 202',
    init: { method: 'POST', headers: { ...base, 'MCP-Protocol-Version': VERSION }, body: rpc({ method: 'notifications/initialized' }) },
    expectStatus: 202,
  },
  {
    name: 'tools/list',
    init: { method: 'POST', headers: { ...base, 'MCP-Protocol-Version': VERSION }, body: rpc({ id: 2, method: 'tools/list' }) },
    expectStatus: 200,
  },
  {
    name: 'tools/call health_check',
    init: {
      method: 'POST',
      headers: { ...base, 'MCP-Protocol-Version': VERSION },
      body: rpc({ id: 3, method: 'tools/call', params: { name: 'health_check', arguments: {} } }),
    },
    expectStatus: 200,
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
  const res = await fetch(url, check.init);
  const text = await res.text();
  const ok = res.status === check.expectStatus;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.name}  (HTTP ${res.status}, expected ${check.expectStatus})`);
  if (text) console.log(`      ${text.length > 220 ? `${text.slice(0, 220)}…` : text}`);
}
console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
