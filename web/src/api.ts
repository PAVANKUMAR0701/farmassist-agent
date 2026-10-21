/**
 * Talks to the FarmAssist chat backend (same origin) and to Amazon Cognito for sign-in.
 * The browser only ever holds the user's own Cognito tokens: no AWS keys, no MCP token.
 */

export interface PublicConfig {
  auth: 'cognito' | 'dev';
  region?: string;
  userPoolClientId?: string;
}

interface Session {
  idToken: string;
  refreshToken?: string;
  /** Epoch ms after which the ID token must be refreshed. */
  expiresAt: number;
  username: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Cognito's error name (e.g. "UserNotConfirmedException"), when the error came from Cognito. */
    readonly code?: string,
  ) {
    super(message);
  }
}

const SESSION_KEY = 'farmassist.session';
let config: PublicConfig | undefined;
/** Called when the session is gone (signed out, or the server rejected the token). */
let onSignedOut: (reason?: string) => void = () => {};

export function setSignedOutHandler(handler: (reason?: string) => void): void {
  onSignedOut = handler;
}

/** True on the local development server (dev sign-in, test data). Known once loadConfig() has resolved. */
export const isLocalDevServer = () => config?.auth === 'dev';

export async function loadConfig(): Promise<PublicConfig> {
  if (!config) {
    const res = await fetch('/api/config');
    if (!res.ok) throw new ApiError(res.status, 'Could not load settings.');
    config = (await res.json()) as PublicConfig;
  }
  return config;
}

function readSession(): Session | undefined {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : undefined;
  } catch {
    return undefined;
  }
}

function writeSession(session: Session | undefined): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Private mode etc.: the user just has to sign in again after a reload.
  }
}

export function isSignedIn(): boolean {
  return readSession() !== undefined;
}

/** Display name from the ID token. Only for showing in the UI: the server verifies the token itself. */
export function displayName(): string {
  const session = readSession();
  if (!session) return '';
  try {
    const payload = JSON.parse(atob(session.idToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    return String(payload.name ?? payload['cognito:username'] ?? session.username);
  } catch {
    return session.username;
  }
}

export function signOut(reason?: string): void {
  writeSession(undefined);
  onSignedOut(reason);
}

// ---- Cognito (USER_PASSWORD_AUTH over HTTPS, straight to the Cognito endpoint) ----

interface AuthResult {
  IdToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
}

export type SignInStep =
  | { done: true }
  | { done: false; newPasswordRequired: true; challengeSession: string }
  /** Signed up but the email code was never entered: confirm, then sign in again. */
  | { done: false; confirmRequired: true };

async function cognito(target: string, body: object): Promise<Record<string, unknown>> {
  const cfg = await loadConfig();
  const res = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const type = String(data.__type ?? '');
    const message =
      type.includes('UserNotConfirmed')
        ? 'Please confirm your email first.'
        : type.includes('NotAuthorized') || type.includes('UserNotFound')
          ? 'Wrong username or password.'
          : type.includes('UsernameExists')
            ? 'That username is already taken. Please choose another one.'
            : type.includes('InvalidPassword')
              ? 'The password needs at least 8 characters, with a small letter and a number.'
              : type.includes('CodeMismatch')
                ? 'That code is not right. Check the email and try again.'
                : type.includes('ExpiredCode')
                  ? 'That code has expired. Tap "Send a new code".'
                  : type.includes('CodeDeliveryFailure')
                    ? 'The code email could not be sent. Check the email address.'
                    : type.includes('TooManyRequests') || type.includes('LimitExceeded') || type.includes('TooManyFailedAttempts')
                      ? 'Too many attempts. Wait a few minutes and try again.'
                      : type.includes('InvalidParameter')
                        ? 'Please check the details: the username can use letters and numbers, and the email must be valid.'
                        : 'Something went wrong. Please try again.';
    throw new ApiError(res.status, message, type.replace(/^.*#/, ''));
  }
  return data;
}

function storeAuthResult(result: AuthResult, username: string, keepRefreshToken?: string): void {
  writeSession({
    idToken: result.IdToken,
    ...((result.RefreshToken ?? keepRefreshToken) ? { refreshToken: result.RefreshToken ?? keepRefreshToken } : {}),
    expiresAt: Date.now() + (result.ExpiresIn - 60) * 1000,
    username,
  });
}

export async function signIn(username: string, password: string): Promise<SignInStep> {
  const cfg = await loadConfig();
  if (cfg.auth === 'dev') {
    writeSession({ idToken: 'dev-local', expiresAt: Number.MAX_SAFE_INTEGER, username: username || 'dev' });
    return { done: true };
  }
  let data: Record<string, unknown>;
  try {
    data = await cognito('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: cfg.userPoolClientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'UserNotConfirmedException') return { done: false, confirmRequired: true };
    throw error;
  }
  if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    return { done: false, newPasswordRequired: true, challengeSession: String(data.Session) };
  }
  storeAuthResult(data.AuthenticationResult as AuthResult, username);
  return { done: true };
}

/** First sign-in with a temporary password: Cognito asks for a permanent one. */
export async function setNewPassword(username: string, newPassword: string, challengeSession: string): Promise<void> {
  const cfg = await loadConfig();
  const data = await cognito('RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: cfg.userPoolClientId,
    Session: challengeSession,
    ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword },
  });
  storeAuthResult(data.AuthenticationResult as AuthResult, username);
}

// ---- Self sign-up: Cognito emails a 6-digit code; the new account gets its own private farm. ----

/** Where the code was sent, masked by Cognito (e.g. "p***@g***"). */
export interface CodeDelivery {
  destination?: string;
}

export async function signUp(username: string, password: string, email: string, name: string): Promise<CodeDelivery> {
  const cfg = await loadConfig();
  if (cfg.auth === 'dev') return { destination: email }; // the local server has no Cognito: any code works
  const data = await cognito('SignUp', {
    ClientId: cfg.userPoolClientId,
    Username: username,
    Password: password,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'name', Value: name },
    ],
  });
  const details = data.CodeDeliveryDetails as { Destination?: string } | undefined;
  return details?.Destination ? { destination: details.Destination } : {};
}

export async function confirmSignUp(username: string, code: string): Promise<void> {
  const cfg = await loadConfig();
  if (cfg.auth === 'dev') return;
  await cognito('ConfirmSignUp', { ClientId: cfg.userPoolClientId, Username: username, ConfirmationCode: code });
}

export async function resendCode(username: string): Promise<CodeDelivery> {
  const cfg = await loadConfig();
  if (cfg.auth === 'dev') return {};
  const data = await cognito('ResendConfirmationCode', { ClientId: cfg.userPoolClientId, Username: username });
  const details = data.CodeDeliveryDetails as { Destination?: string } | undefined;
  return details?.Destination ? { destination: details.Destination } : {};
}

async function idToken(): Promise<string> {
  const session = readSession();
  if (!session) throw new ApiError(401, 'Please sign in.');
  if (Date.now() < session.expiresAt) return session.idToken;
  if (!session.refreshToken) throw new ApiError(401, 'Your session has ended. Please sign in again.');
  const cfg = await loadConfig();
  const data = await cognito('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: cfg.userPoolClientId,
    AuthParameters: { REFRESH_TOKEN: session.refreshToken },
  });
  storeAuthResult(data.AuthenticationResult as AuthResult, session.username, session.refreshToken);
  return readSession()!.idToken;
}

// ---- FarmAssist backend ----

async function post<T>(path: string, body: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await idToken()}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) signOut(error.message);
      throw error;
    }
    throw new ApiError(0, 'Cannot reach FarmAssist. Check your internet connection and try again.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (res.status === 401) {
    signOut('Your session has ended. Please sign in again.');
    throw new ApiError(401, data.error ?? 'Please sign in again.');
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Something went wrong. Please try again.');
  return data;
}

export interface ChatReply {
  conversationId: string;
  reply: string;
  mode: 'model' | 'fallback';
  modelId?: string;
  modelUnavailable?: boolean;
  /** A spoken change is waiting: `reply` is the read-back question, to be answered "yes" or "no". */
  awaitingConfirmation?: boolean;
  confirmed?: boolean;
  /** Every MCP tool the assistant called for this reply: its first line of text, time taken and arguments. */
  actions: Array<{ tool: string; ok: boolean; text: string; ms?: number; input?: Record<string, unknown> }>;
}

/** `voice: true` marks a spoken message: the backend then reads changes back and waits for a yes. */
export function sendChat(message: string, conversationId?: string, voice = false): Promise<ChatReply> {
  return post<ChatReply>('/api/chat', { message, ...(conversationId ? { conversationId } : {}), ...(voice ? { voice: true } : {}) });
}

/**
 * Read requests in flight at once. Each read runs two Lambda functions (chat, then MCP), and the AWS account
 * allows 10 concurrent runs in total: six dashboard cards at once were throttled and showed "Could not load"
 * (seen live 2026-10-21).
 */
const MAX_PARALLEL_READS = 2;
let readsInFlight = 0;
const readQueue: Array<() => void> = [];
async function readSlot<T>(run: () => Promise<T>): Promise<T> {
  if (readsInFlight >= MAX_PARALLEL_READS) await new Promise<void>((resolve) => readQueue.push(resolve));
  readsInFlight++;
  try {
    return await run();
  } finally {
    readsInFlight--;
    readQueue.shift()?.();
  }
}

/** Calls a read-only MCP tool. `data` is the tool's structured result, exactly as the server computed it. */
export function readTool<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: T }> {
  return readSlot(async () => {
    try {
      return await post<{ text: string; data: T }>('/api/read', { tool, args });
    } catch (error) {
      // Busy backend (throttled): one quiet retry. Reads change nothing, so retrying is safe.
      if (!(error instanceof ApiError) || ![429, 502, 503].includes(error.status)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 700));
      return post<{ text: string; data: T }>('/api/read', { tool, args });
    }
  });
}

export interface PhotoReply {
  photoId?: string;
  reply: string;
  urgent: boolean;
  notifiable: boolean;
  needsBetterPhoto: boolean;
  matches: Array<{ id: string; title: string; readMore: string }>;
}

/** Sends a (shrunk) photo for photo help. `note` is what the farmer typed or said about it. */
export function sendPhoto(imageBase64: string, format: 'jpeg' | 'png' | 'webp', note?: string): Promise<PhotoReply> {
  return post<PhotoReply>('/api/photo', { image: imageBase64, format, ...(note ? { note } : {}) });
}
