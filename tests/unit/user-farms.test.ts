import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { describe, expect, it, vi } from 'vitest';
import { farmIdFromClaims, type UserTokenVerifier } from '../../src/auth/cognito-farm.js';
import { FarmMcpClient } from '../../src/agent/mcp-client.js';
import { handleMcpRequest, type McpHttpConfig } from '../../src/mcp/http.js';
import { ENDPOINT, TEST_FARM_ID, TEST_TOKEN, makeTestConfig } from '../helpers/mcp-http.js';

const SUB_A = '1b2c3d4e-0000-4a5b-8c9d-0123456789ab';
const SUB_B = '9f8e7d6c-1111-4a5b-8c9d-ba9876543210';

describe('farmIdFromClaims', () => {
  it('uses the admin-set farm when there is one', () => {
    expect(farmIdFromClaims({ sub: SUB_A, 'custom:farmId': 'demo-farm' })).toBe('demo-farm');
  });
  it('gives a self-signed-up user a private farm named after their user id', () => {
    expect(farmIdFromClaims({ sub: SUB_A })).toBe(`u-${SUB_A}`);
    expect(farmIdFromClaims({ sub: SUB_B })).not.toBe(farmIdFromClaims({ sub: SUB_A }));
  });
  it('rejects malformed farm ids and subjects', () => {
    expect(farmIdFromClaims({ sub: SUB_A, 'custom:farmId': 'bad farm/../x' })).toBeUndefined();
    expect(farmIdFromClaims({ sub: SUB_A, 'custom:farmId': 42 })).toBeUndefined();
    expect(farmIdFromClaims({ sub: 'not-a-uuid' })).toBeUndefined();
    expect(farmIdFromClaims({})).toBeUndefined();
  });
});

/** Stand-in for Cognito: "user-a.jwt" and "user-b.jwt" are valid ID tokens for two signed-up users. */
const fakeVerifier: UserTokenVerifier = {
  verify: async (token): Promise<AuthInfo | undefined> => {
    const sub = token === 'user-a.jwt' ? SUB_A : token === 'user-b.jwt' ? SUB_B : undefined;
    return sub ? { token, clientId: 'web-user', scopes: [], extra: { farmId: farmIdFromClaims({ sub }) } } : undefined;
  },
};

function clientFor(config: McpHttpConfig, token: string) {
  return new FarmMcpClient({ url: ENDPOINT, token, fetch: (url, init) => handleMcpRequest(new Request(url, init), config) });
}

describe('MCP server with signed-up users', () => {
  it('keeps each signed-up user in their own farm, separate from the demo farm', async () => {
    const config: McpHttpConfig = { ...makeTestConfig().config, userTokens: fakeVerifier };
    const userA = clientFor(config, 'user-a.jwt');
    const userB = clientFor(config, 'user-b.jwt');
    const demo = clientFor(config, TEST_TOKEN);

    const saved = await userA.callTool('record_expense', { amountRupees: 500, category: 'feed' });
    expect(saved.isError).toBe(false);

    const totalOf = async (client: FarmMcpClient) =>
      (await client.callTool('get_expense_summary', { period: 'today' })).structured?.totalDisplay;
    expect(await totalOf(userA)).toBe('₹500.00');
    expect(await totalOf(userB)).toBe('₹0.00');
    expect(await totalOf(demo)).toBe('₹0.00');
  });

  it('still refuses unknown tokens, and never asks the user-token check about the service token', async () => {
    const verify = vi.fn(fakeVerifier.verify);
    const config: McpHttpConfig = { ...makeTestConfig().config, userTokens: { verify } };
    const res = await handleMcpRequest(
      new Request(ENDPOINT, { method: 'POST', headers: { Authorization: 'Bearer forged.jwt', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' }),
      config,
    );
    expect(res.status).toBe(401);
    await clientFor(config, TEST_TOKEN).listTools();
    expect(verify).toHaveBeenCalledTimes(1); // only for the forged token
  });

  it('without a user-token verifier, user tokens are refused (the static token alone is unchanged)', async () => {
    const { config } = makeTestConfig();
    await expect(clientFor(config, 'user-a.jwt').listTools()).rejects.toThrow();
    expect((await clientFor(config, TEST_TOKEN).listTools()).length).toBeGreaterThan(0);
    expect(TEST_FARM_ID).toBe('test-farm');
  });
});
