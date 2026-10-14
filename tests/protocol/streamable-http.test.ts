import { describe, expect, it } from 'vitest';
import { handleMcpRequest } from '../../src/mcp/http.js';
import { ALLOWED_ORIGIN, ENDPOINT, makeTestConfig, postJson } from '../helpers/mcp-http.js';

const { config } = makeTestConfig();
const post = (body: unknown, headers: Record<string, string> = {}) => postJson(config, body, headers);

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'protocol-test', version: '1.0.0' },
  },
};

describe('Streamable HTTP transport (MCP 2025-11-25)', () => {
  it('initialize returns JSON with the negotiated protocol version and no session id (stateless)', async () => {
    const res = await post(initializeRequest);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = await res.json();
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2025-11-25');
    expect(body.result.serverInfo.name).toBe('farmassist-agent');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('accepts an older supported client version (2025-03-26) during negotiation', async () => {
    const res = await post({ ...initializeRequest, params: { ...initializeRequest.params, protocolVersion: '2025-03-26' } });
    expect(res.status).toBe(200);
    expect((await res.json()).result.protocolVersion).toBe('2025-03-26');
  });

  it('notifications/initialized gets 202 Accepted with an empty body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'MCP-Protocol-Version': '2025-11-25' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('tools/list includes health_check and record_expense with schemas', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'MCP-Protocol-Version': '2025-11-25' });
    expect(res.status).toBe(200);
    const { tools } = (await res.json()).result;
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['health_check', 'record_expense']));
    const recordExpense = tools.find((t: { name: string }) => t.name === 'record_expense');
    expect(recordExpense.inputSchema.required).toEqual(expect.arrayContaining(['amountRupees', 'category']));
    expect(recordExpense.outputSchema).toBeDefined();
  });

  it('tools/call health_check returns structured content', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health_check', arguments: {} } },
      { 'MCP-Protocol-Version': '2025-11-25' },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent).toMatchObject({ status: 'ok', todayInFarmTimeZone: '2026-10-14' });
  });

  it('rejects an unsupported MCP-Protocol-Version header with 400', async () => {
    const res = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'MCP-Protocol-Version': '1999-01-01' });
    expect(res.status).toBe(400);
  });

  it('rejects a POST whose Accept header lacks text/event-stream with 406', async () => {
    const res = await post(initializeRequest, { Accept: 'application/json' });
    expect(res.status).toBe(406);
  });

  it('rejects malformed JSON with 400 and JSON-RPC parse error -32700', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it('returns 405 with Allow: POST for GET (no server-initiated SSE stream)', async () => {
    const res = await handleMcpRequest(new Request(ENDPOINT, { method: 'GET', headers: { Accept: 'text/event-stream' } }), config);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('returns 405 for DELETE (stateless server has no sessions to terminate)', async () => {
    const res = await handleMcpRequest(new Request(ENDPOINT, { method: 'DELETE' }), config);
    expect(res.status).toBe(405);
  });

  it('rejects a present but disallowed Origin with 403', async () => {
    const res = await post(initializeRequest, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.id).toBeNull();
  });

  it('allows a request from an allowed Origin', async () => {
    const res = await post(initializeRequest, { Origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(200);
  });
});

describe('Bearer authentication', () => {
  it('returns 401 without a WWW-Authenticate header when the token is missing', async () => {
    const res = await post(initializeRequest, { Authorization: '' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('returns 401 for a wrong token', async () => {
    const res = await post(initializeRequest, { Authorization: 'Bearer wrong-token-wrong-token-wrong-token' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const res = await post(initializeRequest, { Authorization: 'Basic dXNlcjpwYXNz' });
    expect(res.status).toBe(401);
  });
});
