import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/**
 * Phase 1 demo auth: a static bearer token mapped to one farm. The farm id comes from the token,
 * never from tool arguments, so a caller can only ever read or write its own farm.
 */
export interface ApiTokenGrant {
  token: string;
  farmId: string;
  clientId: string;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export function authenticateBearer(authorizationHeader: string | null, grants: readonly ApiTokenGrant[]): AuthInfo | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? '');
  if (!match) return undefined;
  const presented = sha256(match[1]!);
  // Hash both sides so lengths match and the comparison is constant-time.
  const grant = grants.find((g) => timingSafeEqual(presented, sha256(g.token)));
  if (!grant) return undefined;
  return { token: grant.token, clientId: grant.clientId, scopes: ['farm:read', 'farm:write'], extra: { farmId: grant.farmId } };
}

/** Reads the authenticated farm id that http.ts attached to the request. */
export function farmIdFromAuth(authInfo: AuthInfo | undefined): string {
  const farmId = authInfo?.extra?.farmId;
  if (typeof farmId !== 'string' || farmId.length === 0) throw new Error('Request is not authenticated');
  return farmId;
}
