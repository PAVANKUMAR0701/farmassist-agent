/**
 * Local development server for the web client and chat backend: http://127.0.0.1:5173
 *
 * Runs the same handleChatRequest() as the chat Lambda. Sign-in is a local dev login (no Cognito), and
 * MCP calls go to an in-process FarmAssist server with in-memory storage, unless FARMASSIST_MCP_URL is set.
 * Set AGENT_MODEL_ID (+ BEDROCK_AWS_PROFILE) to chat through Bedrock; otherwise the deterministic parser answers.
 *
 *   npm run build:web && npm run start:chat
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { FarmMcpClient } from '../src/agent/mcp-client.js';
import { createAgentModelFromEnv } from '../src/agent/model.js';
import { handleChatRequest, type ChatAppDeps } from '../src/chat/app.js';
import { DevAuthenticator } from '../src/chat/auth.js';
import { InMemoryConversationStore } from '../src/chat/conversations.js';
import { WEB_ASSETS } from '../src/chat/web-assets.generated.js';
import { handleMcpRequest } from '../src/mcp/http.js';
import { InMemoryLedgerRepository } from '../src/repositories/memory-ledger-repository.js';
import { InMemoryRecordStore } from '../src/repositories/record-store.js';
import { createNarratorFromEnv } from '../src/services/insight-narrator.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const HOST = '127.0.0.1'; // the dev login below must never be reachable from another machine
const PORT = Number(process.env.CHAT_PORT ?? 5173);
const farmId = process.env.FARMASSIST_DEMO_FARM_ID ?? 'demo-farm';
const remoteMcpUrl = process.env.FARMASSIST_MCP_URL;
const mcpToken = remoteMcpUrl ? process.env.FARMASSIST_API_TOKEN : 'local-in-process-token-0123456789abcdef';
if (!mcpToken) throw new Error('FARMASSIST_API_TOKEN is required with FARMASSIST_MCP_URL');

// In-process MCP server (in-memory ledger) unless a real endpoint was given.
const ledger = new InMemoryLedgerRepository();
const localMcp = {
  allowedOrigins: [] as string[],
  apiTokens: [{ token: mcpToken, farmId, clientId: 'local-chat' }],
  deps: { ledger, records: new InMemoryRecordStore(), now: () => new Date(), narrator: createNarratorFromEnv() },
};
const tools = new FarmMcpClient({
  url: remoteMcpUrl ?? 'http://in-process/mcp',
  token: mcpToken,
  ...(remoteMcpUrl ? {} : { fetch: (url: string | URL, init?: RequestInit) => handleMcpRequest(new Request(url, init), localMcp) }),
});

/** `--seed`: a small sample farm, created through the real MCP tools, for trying the screens locally. */
async function seedSampleFarm(): Promise<void> {
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const calls: Array<[string, Record<string, unknown>]> = [
    ['register_animal', { animals: [{ name: 'Lakshmi', type: 'cow', breed: 'HF', birthDate: '2022-07-10' }, { name: 'Maya', type: 'cow', breed: 'Jersey' }, { name: 'Geeta', type: 'cow' }, { name: 'Sita', type: 'cow', breed: 'Gir' }] }],
    ['register_animal', { animals: [{ name: 'Seetha', type: 'calf', motherName: 'Lakshmi', birthDate: day(15) }] }],
    ...[0, 1, 2, 3, 4, 5, 6].flatMap((d): Array<[string, Record<string, unknown>]> => [
      ['record_milk', { litres: 8 + (d % 3) * 0.5, session: 'morning', animalName: 'Lakshmi', date: day(d) }],
      ['record_milk', { litres: 6.5, session: 'evening', animalName: 'Lakshmi', date: day(d) }],
      ['record_milk', { litres: 7, animalName: 'Maya', date: day(d) }],
    ]),
    ['record_sowing', { crop: 'paddy', variety: 'Sona Masuri', field: 'north field', areaAcres: 2, seedQuantity: 50, sownDate: day(118) }],
    ['record_harvest', { crop: 'paddy', field: 'north field', quantity: 30, unit: 'quintal', date: day(2), final: true }],
    ['record_sowing', { crop: 'ragi', field: 'east plot', areaAcres: 1, seedQuantity: 10, sownDate: day(60) }],
    ['add_insurance', { animalName: 'Lakshmi', insurer: 'United India', endDate: inDays(20), premiumRupees: 1850 }],
    ['add_reminder', { title: 'Deworm the calf', dueDate: inDays(4), animalName: 'Seetha' }],
    ['record_expense', { amountRupees: 2500, category: 'feed', note: 'cattle feed' }],
    ['record_expense', { amountRupees: 1200, category: 'fuel', note: 'diesel' }],
  ];
  for (const [name, args] of calls) {
    const result = await tools.callTool(name, args);
    if (result.isError) console.warn(`seed: ${name} failed: ${result.text}`);
  }
  console.log('Seeded a sample farm (5 animals, 7 days of milk, 2 crops, insurance, a reminder, 2 expenses).');
}
if (process.argv.includes('--seed') && !remoteMcpUrl) await seedSampleFarm();

const deps: ChatAppDeps = {
  auth: new DevAuthenticator('dev-local', { userId: 'dev-user', farmId, name: 'Local dev' }),
  conversations: new InMemoryConversationStore(),
  toolsFor: (id) => (id === farmId ? tools : undefined),
  model: createAgentModelFromEnv(),
  assets: WEB_ASSETS,
  publicConfig: { auth: 'dev' },
};

createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const response = await handleChatRequest(
      new Request(new URL(req.url ?? '/', `http://${HOST}:${PORT}`), { method: req.method ?? 'GET', headers, body: hasBody ? Buffer.concat(chunks).toString('utf8') : undefined }),
      deps,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Unhandled error in local chat server', error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
}).listen(PORT, HOST, () => {
  console.log(`FarmAssist web client on http://${HOST}:${PORT}  (local dev sign-in)`);
  console.log(remoteMcpUrl ? `MCP: ${remoteMcpUrl}` : 'MCP: in-process server, IN-MEMORY data (lost on restart)');
  console.log(deps.model ? `Agent model: ${deps.model.modelId}` : 'Agent model: none (deterministic parser)');
});
