/**
 * Hosted chat backend for the web client. One origin serves:
 *   GET  /, /app.js, /styles.css   the web client (static files bundled into the function)
 *   GET  /api/config               public sign-in settings (Cognito region and app client id)
 *   POST /api/chat                 one agent turn: { message, conversationId?, voice? }
 *                                  (voice: true holds ledger changes until the farmer says yes)
 *   POST /api/read                 one read-only MCP tool call for screens: { tool, args }
 *
 * Every /api/chat and /api/read call needs a valid sign-in token. The backend then talks to the MCP server
 * as an MCP client with the farm's MCP token, which never reaches the browser.
 */
import { ulid } from 'ulid';
import { FarmAgent } from '../agent/agent.js';
import type { FarmToolClient } from '../agent/mcp-client.js';
import type { AgentModel } from '../agent/model.js';
import type { ChatAuthenticator, ChatUser } from './auth.js';
import { CONVERSATION_ID, type ConversationStore } from './conversations.js';

export interface StaticAsset {
  contentType: string;
  body: string;
}

export interface PublicConfig {
  auth: 'cognito' | 'dev';
  region?: string;
  userPoolClientId?: string;
}

export interface ChatAppDeps {
  auth: ChatAuthenticator;
  conversations: ConversationStore;
  /** MCP connection for a farm, or undefined when that farm has no MCP access configured. */
  toolsFor(farmId: string): FarmToolClient | undefined;
  model?: AgentModel | undefined;
  assets: Record<string, StaticAsset>;
  publicConfig: PublicConfig;
  now?: () => Date;
}

/** Read-only tools the screens may call directly. Writes only ever happen through the agent. */
export const READ_TOOLS = new Set(['get_expense_summary', 'list_expenses', 'get_daily_summary', 'list_activities', 'weekly_insights']);
export const MAX_MESSAGE_LENGTH = 500;
const MAX_BODY_BYTES = 16 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
  });
}
const problem = (status: number, error: string) => json(status, { error });

function contentSecurityPolicy(config: PublicConfig): string {
  const cognito = config.region ? ` https://cognito-idp.${config.region}.amazonaws.com` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self'${cognito}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function handleChatRequest(request: Request, deps: ChatAppDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname === '/' ? '/index.html' : url.pathname;

  if (request.method === 'GET') {
    const asset = deps.assets[path];
    if (asset) {
      return new Response(asset.body, {
        headers: {
          'Content-Type': asset.contentType,
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': contentSecurityPolicy(deps.publicConfig),
          ...SECURITY_HEADERS,
        },
      });
    }
    if (path === '/api/config') return json(200, deps.publicConfig);
    return problem(404, 'Not found');
  }

  if (request.method !== 'POST' || (path !== '/api/chat' && path !== '/api/read')) return problem(path.startsWith('/api/') ? 405 : 404, 'Not found');

  const user = await deps.auth.authenticate(request.headers.get('authorization'));
  if (!user) return problem(401, 'Please sign in again.');
  const tools = deps.toolsFor(user.farmId);
  if (!tools) return problem(403, 'This account is not linked to a farm that FarmAssist can open yet.');

  const body = await readJsonBody(request);
  if (!body) return problem(400, 'The request was not valid JSON.');

  try {
    return path === '/api/chat' ? await chat(body, user, tools, deps) : await read(body, tools);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Chat backend request failed', path, error: error instanceof Error ? error.name : 'Unknown' }));
    return problem(502, 'The farm records server could not be reached. Nothing was changed; please try again.');
  }
}

async function chat(body: Record<string, unknown>, user: ChatUser, tools: FarmToolClient, deps: ChatAppDeps): Promise<Response> {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > MAX_MESSAGE_LENGTH) return problem(400, `Write a message of 1 to ${MAX_MESSAGE_LENGTH} characters.`);
  const requested = body.conversationId;
  if (requested !== undefined && (typeof requested !== 'string' || !CONVERSATION_ID.test(requested))) return problem(400, 'Invalid conversationId.');

  const conversationId = (requested as string | undefined) ?? ulid();
  const key = { farmId: user.farmId, userId: user.userId, conversationId };
  const state = requested ? await deps.conversations.load(key) : undefined;
  const agent = new FarmAgent({ tools, model: deps.model, state, ...(deps.now ? { now: deps.now } : {}) });
  const turn = await agent.handle(message, { confirmWrites: body.voice === true });
  await deps.conversations.save(key, agent.exportState());

  return json(200, {
    conversationId,
    reply: turn.reply,
    mode: turn.mode,
    ...(turn.mode === 'model' && deps.model ? { modelId: deps.model.modelId } : {}),
    ...(turn.modelError ? { modelUnavailable: true } : {}),
    ...(turn.numberCheck ? { numberCheck: turn.numberCheck } : {}),
    // A write is waiting: the reply is the read-back question; answer "yes" or "no" in the same conversation.
    ...(turn.confirmation ? { awaitingConfirmation: true } : {}),
    ...(turn.confirmed !== undefined ? { confirmed: turn.confirmed } : {}),
    // What the server did, in its own words, so the screen can show it next to the reply.
    actions: turn.toolCalls.map((c) => ({ tool: c.name, ok: !c.result.isError, text: c.result.text.split('\n')[0] })),
  });
}

async function read(body: Record<string, unknown>, tools: FarmToolClient): Promise<Response> {
  const tool = body.tool;
  const args = body.args ?? {};
  if (typeof tool !== 'string' || !READ_TOOLS.has(tool)) return problem(400, 'Unknown or not allowed tool.');
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return problem(400, 'args must be an object.');
  const result = await tools.callTool(tool, args as Record<string, unknown>);
  if (result.isError) return json(422, { error: result.text });
  return json(200, { text: result.text.split('\n')[0], data: result.structured ?? {} });
}
