/**
 * Which farm a signed-in Cognito user works on, used by both the chat backend and the MCP server so they
 * always agree:
 * - users an admin created carry `custom:farmId` (not writable by users), e.g. the shared demo farm;
 * - users who signed up themselves have no `custom:farmId` and get a private farm named after their
 *   Cognito user id ("u-<sub>"). Only a verified token for that user can reach it.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

export const FARM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COGNITO_SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function farmIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const assigned = claims['custom:farmId'];
  if (assigned !== undefined) return typeof assigned === 'string' && FARM_ID_PATTERN.test(assigned) ? assigned : undefined;
  const sub = claims.sub;
  return typeof sub === 'string' && COGNITO_SUB.test(sub) ? `u-${sub.toLowerCase()}` : undefined;
}

/** Turns a bearer token into MCP auth info, or undefined when it is not a valid token for this server. */
export interface UserTokenVerifier {
  verify(token: string): Promise<AuthInfo | undefined>;
}

/** Accepts a web user's Cognito ID token on the MCP server: the farm comes from the verified claims only. */
export class CognitoUserTokenVerifier implements UserTokenVerifier {
  private readonly verifier;

  constructor(userPoolId: string, clientId: string) {
    this.verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' });
  }

  async verify(token: string): Promise<AuthInfo | undefined> {
    try {
      const claims = await this.verifier.verify(token);
      const farmId = farmIdFromClaims(claims as Record<string, unknown>);
      if (!farmId) return undefined;
      return { token, clientId: 'web-user', scopes: ['farm:read', 'farm:write'], extra: { farmId, userId: claims.sub } };
    } catch {
      return undefined; // expired, wrong pool or client, bad signature, ...
    }
  }
}
