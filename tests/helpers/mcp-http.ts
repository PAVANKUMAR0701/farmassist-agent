import { handleMcpRequest, type McpHttpConfig } from '../../src/mcp/http.js';
import { InMemoryLedgerRepository } from '../../src/repositories/memory-ledger-repository.js';

export const ENDPOINT = 'http://127.0.0.1:3000/mcp';
export const ALLOWED_ORIGIN = 'http://localhost:5173';
export const TEST_TOKEN = 'test-token-that-is-at-least-32-characters-long';
export const TEST_FARM_ID = 'test-farm';

export const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: `Bearer ${TEST_TOKEN}`,
};

/** Builds a test config with an in-memory ledger and a fixed clock (default: 2026-10-14 12:00 IST). */
export function makeTestConfig(now: Date = new Date('2026-10-14T06:30:00Z')) {
  const ledger = new InMemoryLedgerRepository(() => now);
  const config: McpHttpConfig = {
    allowedOrigins: [ALLOWED_ORIGIN],
    apiTokens: [{ token: TEST_TOKEN, farmId: TEST_FARM_ID, clientId: 'test' }],
    deps: { ledger, now: () => now },
  };
  return { config, ledger };
}

export function postJson(config: McpHttpConfig, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleMcpRequest(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    config,
  );
}

let nextId = 100;

/** Calls an MCP tool over the real HTTP handler and returns the JSON-RPC result. */
export async function callTool(config: McpHttpConfig, name: string, args: Record<string, unknown>) {
  const res = await postJson(
    config,
    { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
    { 'MCP-Protocol-Version': '2025-11-25' },
  );
  if (res.status !== 200) throw new Error(`Unexpected HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
  return body.result as { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: any };
}
