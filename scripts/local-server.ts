/**
 * Local development server: wraps the same handleMcpRequest() that Lambda will use
 * in a plain Node HTTP server on http://127.0.0.1:3000/mcp.
 *
 * Settings come from environment variables, optionally loaded from .env.local (see .env.example).
 * Without FARMASSIST_TABLE_NAME it stores data in memory only (lost on restart).
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handleMcpRequest, type McpHttpConfig } from '../src/mcp/http.js';
import { DynamoLedgerRepository } from '../src/repositories/dynamodb-ledger-repository.js';
import type { LedgerRepository } from '../src/repositories/ledger-repository.js';
import { InMemoryLedgerRepository } from '../src/repositories/memory-ledger-repository.js';
import { DynamoRecordStore } from '../src/repositories/dynamodb-record-store.js';
import { InMemoryRecordStore, type RecordStore } from '../src/repositories/record-store.js';
import { createNarratorFromEnv } from '../src/services/insight-narrator.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const HOST = '127.0.0.1'; // Spec: local servers SHOULD bind to localhost only.
const PORT = Number(process.env.PORT ?? 3000);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const token = process.env.FARMASSIST_API_TOKEN;
if (!token || token.length < 32) {
  console.error('FARMASSIST_API_TOKEN is missing or shorter than 32 characters. Copy .env.example to .env.local and set it.');
  process.exit(1);
}
const farmId = process.env.FARMASSIST_DEMO_FARM_ID ?? 'demo-farm';

const tableName = process.env.FARMASSIST_TABLE_NAME;
let ledger: LedgerRepository;
let records: RecordStore;
if (tableName) {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  ledger = new DynamoLedgerRepository(client, tableName);
  records = new DynamoRecordStore(client, tableName);
} else {
  ledger = new InMemoryLedgerRepository();
  records = new InMemoryRecordStore();
}

const narrator = createNarratorFromEnv();

const config: McpHttpConfig = {
  allowedOrigins,
  apiTokens: [{ token, farmId, clientId: 'local-dev' }],
  deps: { ledger, records, now: () => new Date(), narrator },
};

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found. The MCP endpoint is /mcp');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }

    const response = await handleMcpRequest(
      new Request(url, {
        method: req.method ?? 'GET',
        headers,
        body: hasBody ? Buffer.concat(chunks).toString('utf8') : undefined,
      }),
      config,
    );

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    console.error('Unhandled error in local MCP server', error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`FarmAssist MCP server listening on http://${HOST}:${PORT}/mcp`);
  console.log(`Allowed browser origins: ${allowedOrigins.join(', ') || '(none)'}`);
  console.log(`Farm: ${farmId}`);
  console.log(tableName ? `Storage: DynamoDB table ${tableName}` : 'Storage: IN MEMORY (data is lost on restart)');
  console.log(narrator ? `Weekly insights: Bedrock model ${narrator.modelId}` : 'Weekly insights: template only (BEDROCK_MODEL_ID not set)');
});
