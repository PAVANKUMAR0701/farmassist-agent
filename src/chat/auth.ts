/**
 * Sign-in for the web client. The browser signs in with Amazon Cognito and sends the ID token as
 * "Authorization: Bearer <token>". The farm comes only from the verified token: the admin-set
 * custom:farmId claim, or a private farm for a user who signed up (see src/auth/cognito-farm.ts),
 * never from anything else the browser sends.
 */
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { farmIdFromClaims } from '../auth/cognito-farm.js';

export interface ChatUser {
  /** Stable user id (Cognito "sub"). Conversations are stored per user. */
  userId: string;
  farmId: string;
  /** Display name for the UI. */
  name: string;
}

export interface ChatAuthenticator {
  /** Returns the user for a valid "Bearer <token>" header, or undefined. Never throws for bad tokens. */
  authenticate(authorizationHeader: string | null): Promise<ChatUser | undefined>;
}

const bearer = (header: string | null) => /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];

export class CognitoAuthenticator implements ChatAuthenticator {
  private readonly verifier;

  constructor(userPoolId: string, clientId: string) {
    this.verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' });
  }

  async authenticate(authorizationHeader: string | null): Promise<ChatUser | undefined> {
    const token = bearer(authorizationHeader);
    if (!token) return undefined;
    try {
      const claims = await this.verifier.verify(token);
      const farmId = farmIdFromClaims(claims as Record<string, unknown>);
      if (!farmId) return undefined;
      const name = typeof claims.name === 'string' ? claims.name : String(claims['cognito:username'] ?? 'Farmer');
      return { userId: claims.sub, farmId, name };
    } catch {
      return undefined; // expired, wrong pool or client, bad signature, ...
    }
  }
}

/**
 * Local development only: accepts one fixed token for one farm. The local server refuses to start it on
 * anything but 127.0.0.1, and it is never used in Lambda.
 */
export class DevAuthenticator implements ChatAuthenticator {
  constructor(
    private readonly token: string,
    private readonly user: ChatUser,
  ) {}

  async authenticate(authorizationHeader: string | null): Promise<ChatUser | undefined> {
    return bearer(authorizationHeader) === this.token ? this.user : undefined;
  }
}
