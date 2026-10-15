import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_ORIGIN, MCP_HEADERS, TEST_TOKEN } from '../helpers/mcp-http.js';

const ssm = mockClient(SSMClient);
const ddb = mockClient(DynamoDBDocumentClient);

function urlEvent(overrides: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown; base64?: boolean } = {}): LambdaFunctionURLEvent {
  const raw = overrides.body === undefined ? undefined : JSON.stringify(overrides.body);
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: overrides.path ?? '/mcp',
    rawQueryString: '',
    headers: Object.fromEntries(Object.entries(overrides.headers ?? MCP_HEADERS).map(([k, v]) => [k.toLowerCase(), v])),
    requestContext: {
      accountId: 'anonymous',
      apiId: 'abc123',
      domainName: 'abc123.lambda-url.ap-south-1.on.aws',
      domainPrefix: 'abc123',
      http: { method: overrides.method ?? 'POST', path: overrides.path ?? '/mcp', protocol: 'HTTP/1.1', sourceIp: '203.0.113.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '15/Oct/2026:06:30:00 +0000',
      timeEpoch: 1_791_959_400_000,
    },
    isBase64Encoded: overrides.base64 ?? false,
    ...(raw === undefined ? {} : { body: overrides.base64 ? Buffer.from(raw).toString('base64') : raw }),
  } as LambdaFunctionURLEvent;
}

const rpc = (id: number, method: string, params?: object) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const afterInit = { ...MCP_HEADERS, 'MCP-Protocol-Version': '2025-11-25' };

/** Fresh module per test, so the cached config does not leak between tests. */
async function loadHandler() {
  vi.resetModules();
  return (await import('../../src/lambda/handler.js')).handler;
}

beforeEach(() => {
  ssm.reset();
  ddb.reset();
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: TEST_TOKEN } });
  vi.stubEnv('FARMASSIST_TOKEN_PARAMETER', '/farmassist/test/api-token');
  vi.stubEnv('FARMASSIST_TABLE_NAME', 'farmassist-test');
  vi.stubEnv('FARMASSIST_DEMO_FARM_ID', 'demo-farm');
  vi.stubEnv('ALLOWED_ORIGINS', ALLOWED_ORIGIN);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Lambda Function URL handler', () => {
  it('answers initialize and reads the token from SSM with decryption', async () => {
    const handler = await loadHandler();
    const res = await handler(
      urlEvent({ body: rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }) }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).result.protocolVersion).toBe('2025-11-25');
    expect(ssm.commandCalls(GetParameterCommand)[0]!.args[0].input).toEqual({ Name: '/farmassist/test/api-token', WithDecryption: true });
  });

  it('lists every farm tool, including get_daily_summary', async () => {
    const handler = await loadHandler();
    const res = await handler(urlEvent({ headers: afterInit, body: rpc(2, 'tools/list') }));
    const names = JSON.parse(res.body!).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['record_expense', 'list_expenses', 'get_expense_summary', 'record_farm_activity', 'correct_entry', 'get_daily_summary']),
    );
  });

  it('decodes base64 bodies and queries the configured table for the token\'s farm', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    const handler = await loadHandler();
    const res = await handler(
      urlEvent({ headers: afterInit, base64: true, body: rpc(3, 'tools/call', { name: 'get_daily_summary', arguments: {} }) }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).result.structuredContent.expenseTotalPaise).toBe(0);
    const query = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(query.TableName).toBe('farmassist-test');
    expect(query.ExpressionAttributeValues![':pk']).toBe('FARM#demo-farm');
  });

  it('returns 202 with no body for notifications', async () => {
    const handler = await loadHandler();
    const res = await handler(urlEvent({ headers: afterInit, body: { jsonrpc: '2.0', method: 'notifications/initialized' } }));
    expect(res.statusCode).toBe(202);
    expect(res.body).toBeUndefined();
  });

  it('keeps the protocol rules: 401 without a token, 403 for a foreign origin, 405 for GET', async () => {
    const handler = await loadHandler();
    const { Authorization: _, ...noAuth } = MCP_HEADERS;
    expect((await handler(urlEvent({ headers: noAuth, body: rpc(4, 'tools/list') }))).statusCode).toBe(401);
    expect((await handler(urlEvent({ headers: { ...afterInit, Origin: 'https://evil.example' }, body: rpc(5, 'tools/list') }))).statusCode).toBe(403);
    const get = await handler(urlEvent({ method: 'GET' }));
    expect(get.statusCode).toBe(405);
    expect(get.headers).toMatchObject({ allow: 'POST' });
  });

  it('returns 404 for paths other than /mcp without loading config', async () => {
    const handler = await loadHandler();
    const res = await handler(urlEvent({ path: '/', body: rpc(6, 'tools/list') }));
    expect(res.statusCode).toBe(404);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(0);
  });

  it('returns 500 when the token cannot be loaded, and retries on the next request', async () => {
    ssm.on(GetParameterCommand).rejectsOnce(new Error('AccessDenied')).resolves({ Parameter: { Value: TEST_TOKEN } });
    const handler = await loadHandler();
    const first = await handler(urlEvent({ headers: afterInit, body: rpc(7, 'tools/list') }));
    expect(first.statusCode).toBe(500);
    expect(first.body).toBe('Internal server error');
    const second = await handler(urlEvent({ headers: afterInit, body: rpc(8, 'tools/list') }));
    expect(second.statusCode).toBe(200);
  });

  it('rejects a token parameter shorter than 32 characters', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'short' } });
    const handler = await loadHandler();
    expect((await handler(urlEvent({ headers: afterInit, body: rpc(9, 'tools/list') }))).statusCode).toBe(500);
  });
});
