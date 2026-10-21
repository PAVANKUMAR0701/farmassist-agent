import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it, vi } from 'vitest';
import { FarmMcpClient, type FarmToolClient } from '../../src/agent/mcp-client.js';
import { handleChatRequest, type ChatAppDeps } from '../../src/chat/app.js';
import { toLambdaResult } from '../../src/lambda/function-url.js';
import { CognitoAuthenticator, type ChatAuthenticator, type ChatUser } from '../../src/chat/auth.js';
import { DynamoConversationStore, InMemoryConversationStore } from '../../src/chat/conversations.js';
import { handleMcpRequest } from '../../src/mcp/http.js';
import { ENDPOINT, makeTestConfig, TEST_FARM_ID, TEST_TOKEN } from '../helpers/mcp-http.js';

const NOW = new Date('2026-10-14T06:30:00Z');
const USERS: Record<string, ChatUser> = {
  'token-asha': { userId: 'asha', farmId: TEST_FARM_ID, name: 'Asha' },
  'token-ravi': { userId: 'ravi', farmId: TEST_FARM_ID, name: 'Ravi' },
  'token-other-farm': { userId: 'meena', farmId: 'farm-without-mcp', name: 'Meena' },
};
const auth: ChatAuthenticator = { authenticate: async (header) => USERS[header?.replace(/^Bearer /, '') ?? ''] };

function setup(overrides: Partial<ChatAppDeps> = {}) {
  const { config, ledger } = makeTestConfig(NOW);
  const tools = new FarmMcpClient({ url: ENDPOINT, token: TEST_TOKEN, fetch: (url, init) => handleMcpRequest(new Request(url, init), config) });
  const deps: ChatAppDeps = {
    auth,
    conversations: new InMemoryConversationStore(),
    toolsFor: (farmId) => (farmId === TEST_FARM_ID ? tools : undefined),
    assets: { '/index.html': { contentType: 'text/html; charset=utf-8', body: '<!doctype html>' }, '/app.js': { contentType: 'text/javascript', body: '1' } },
    publicConfig: { auth: 'cognito', region: 'ap-south-1', userPoolClientId: 'client-123' },
    now: () => NOW,
    ...overrides,
  };
  const expensesToday = () => ledger.getAllExpenses({ farmId: TEST_FARM_ID, from: '2026-10-14', to: '2026-10-14' });
  return { deps, expensesToday };
}

const post = (deps: ChatAppDeps, path: string, body: unknown, token: string | null = 'token-asha') =>
  handleChatRequest(
    new Request(`https://chat.example${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    deps,
  );

describe('static web client and config', () => {
  it('serves the app at / with a strict Content-Security-Policy that allows only this origin and Cognito', async () => {
    const { deps } = setup();
    const res = await handleChatRequest(new Request('https://chat.example/'), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' https://cognito-idp.ap-south-1.amazonaws.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves images byte for byte, cached, and the Lambda result carries them base64-encoded', async () => {
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10, 0x80]); // binary, not valid UTF-8
    const { deps } = setup({
      assets: { '/images/farm-background.webp': { contentType: 'image/webp', body: bytes.toString('base64'), encoding: 'base64' } },
    });
    const res = await handleChatRequest(new Request('https://chat.example/images/farm-background.webp'), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    const lambda = await toLambdaResult(res);
    expect(lambda).toMatchObject({ statusCode: 200, isBase64Encoded: true, body: bytes.toString('base64') });
  });

  it('publishes only public sign-in settings, and 404s unknown paths', async () => {
    const { deps } = setup();
    expect(await (await handleChatRequest(new Request('https://chat.example/api/config'), deps)).json()).toEqual({
      auth: 'cognito',
      region: 'ap-south-1',
      userPoolClientId: 'client-123',
    });
    expect((await handleChatRequest(new Request('https://chat.example/.env'), deps)).status).toBe(404);
  });
});

describe('access control and validation', () => {
  it('401 without or with a bad token, 403 for a user whose farm has no MCP access', async () => {
    const { deps } = setup();
    expect((await post(deps, '/api/chat', { message: 'hi' }, null)).status).toBe(401);
    expect((await post(deps, '/api/chat', { message: 'hi' }, 'forged')).status).toBe(401);
    expect((await post(deps, '/api/read', { tool: 'list_expenses' }, 'token-other-farm')).status).toBe(403);
  });

  it('400 for broken JSON, empty or overlong messages and bad conversation ids', async () => {
    const { deps } = setup();
    expect((await post(deps, '/api/chat', '{not json')).status).toBe(400);
    expect((await post(deps, '/api/chat', { message: '   ' })).status).toBe(400);
    expect((await post(deps, '/api/chat', { message: 'x'.repeat(501) })).status).toBe(400);
    expect((await post(deps, '/api/chat', { message: 'hi', conversationId: '../../etc' })).status).toBe(400);
  });

  it('405 for other methods on the API', async () => {
    const { deps } = setup();
    expect((await handleChatRequest(new Request('https://chat.example/api/chat', { method: 'DELETE' }), deps)).status).toBe(405);
  });
});

describe('POST /api/chat', () => {
  it('records, then corrects in a second request of the same conversation', async () => {
    const { deps, expensesToday } = setup();
    const first = await (await post(deps, '/api/chat', { message: 'spent 2500 on feed' })).json();
    expect(first).toMatchObject({ mode: 'fallback', reply: 'Recorded ₹2,500.00 on feed for 2026-10-14.', actions: [{ tool: 'record_expense', ok: true }] });
    expect(first.conversationId).toMatch(/^[0-9A-Z]{26}$/);

    const second = await (await post(deps, '/api/chat', { message: 'no, it was 900', conversationId: first.conversationId })).json();
    expect(second.reply).toContain('₹2,500.00 → ₹900.00');
    expect(await expensesToday()).toMatchObject([{ amountPaise: 90000 }]);
  });

  it('keeps conversations per user: another user cannot continue it, even with its id', async () => {
    const { deps, expensesToday } = setup();
    const first = await (await post(deps, '/api/chat', { message: 'spent 2500 on feed' })).json();
    const intruder = await (await post(deps, '/api/chat', { message: 'no, it was 1', conversationId: first.conversationId }, 'token-ravi')).json();
    expect(intruder.actions).toEqual([]); // fresh conversation: no "last expense" to correct
    expect(await expensesToday()).toMatchObject([{ amountPaise: 250000 }]);
  });

  it('502 with "nothing was changed" when the MCP server cannot be reached', async () => {
    const broken: FarmToolClient = {
      listTools: async () => [],
      callTool: async () => {
        throw new TypeError('fetch failed');
      },
    };
    const { deps } = setup({ toolsFor: () => broken });
    const res = await post(deps, '/api/chat', { message: 'spent 2500 on feed' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('Nothing was changed');
  });

  it("hands the signed-in user's own token to the MCP connection for their farm (signed-up users)", async () => {
    const toolsFor = vi.fn((_farmId: string, _userToken?: string) => undefined);
    const { deps } = setup({ toolsFor });
    await post(deps, '/api/read', { tool: 'list_crops', args: {} }, 'token-other-farm');
    expect(toolsFor).toHaveBeenCalledWith('farm-without-mcp', 'token-other-farm');
  });
});

describe('POST /api/read', () => {
  it('returns the server\'s structured result for an allowed read tool', async () => {
    const { deps } = setup();
    await post(deps, '/api/chat', { message: 'spent 2500 on feed' });
    const res = await post(deps, '/api/read', { tool: 'get_expense_summary', args: { period: 'today' } });
    expect(await res.json()).toMatchObject({ data: { totalPaise: 250000, totalDisplay: '₹2,500.00', calculatedBy: 'server' } });
  });

  it('refuses write tools and unknown tools: writes only happen through the agent', async () => {
    const { deps, expensesToday } = setup();
    for (const tool of ['record_expense', 'correct_entry', 'record_farm_activity', 'drop_table']) {
      expect((await post(deps, '/api/read', { tool, args: { amountRupees: 1, category: 'feed' } })).status).toBe(400);
    }
    expect(await expensesToday()).toHaveLength(0);
  });

  it('passes tool validation errors back as 422', async () => {
    const { deps } = setup();
    const res = await post(deps, '/api/read', { tool: 'list_expenses', args: { limit: 999 } });
    expect(res.status).toBe(422);
  });
});

describe('CognitoAuthenticator', () => {
  it('rejects missing, malformed and forged tokens without throwing', async () => {
    const authenticator = new CognitoAuthenticator('ap-south-1_example', 'client-123');
    expect(await authenticator.authenticate(null)).toBeUndefined();
    expect(await authenticator.authenticate('Basic abc')).toBeUndefined();
    const forged = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"custom:farmId":"demo-farm"}').toString('base64url')}.`;
    expect(await authenticator.authenticate(`Bearer ${forged}`)).toBeUndefined();
  });
});

describe('DynamoConversationStore', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const store = new DynamoConversationStore(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' })), 'T', () => NOW);
  const key = { farmId: 'farm-1', userId: 'u1', conversationId: 'conv-12345678' };

  it('stores state per farm and user with a 24-hour TTL', async () => {
    ddb.reset();
    ddb.on(PutCommand).resolves({});
    await store.save(key, { history: [] });
    const item = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(item).toMatchObject({ PK: 'FARM#farm-1', SK: 'CONV#u1#conv-12345678', type: 'CONVERSATION', expiresAt: Math.floor(NOW.getTime() / 1000) + 86400 });
  });

  it('treats an expired item as gone even before DynamoDB deletes it', async () => {
    ddb.reset();
    ddb.on(GetCommand).resolves({ Item: { state: '{"history":[]}', expiresAt: Math.floor(NOW.getTime() / 1000) - 1 } });
    expect(await store.load(key)).toBeUndefined();
  });
});

describe('voice turns over the API', () => {
  it('holds a spoken write until "yes" arrives in the same conversation', async () => {
    const { deps, expensesToday } = setup();
    const ask = await (await post(deps, '/api/chat', { message: 'spent 2500 on feed', voice: true })).json();
    expect(ask).toMatchObject({ awaitingConfirmation: true, reply: expect.stringContaining('Shall I record ₹2,500.00 on feed for today?') });
    expect(await expensesToday()).toHaveLength(0);

    const done = await (await post(deps, '/api/chat', { message: 'yes', voice: true, conversationId: ask.conversationId })).json();
    expect(done).toMatchObject({ confirmed: true, reply: 'Recorded ₹2,500.00 on feed for 2026-10-14.' });
    expect(await expensesToday()).toHaveLength(1);
  });
});
