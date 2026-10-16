/**
 * Concurrency and pagination checks against a deployed FarmAssist endpoint and its real DynamoDB table.
 * The unit tests mock DynamoDB, so this is where conditional writes and transactions are proven for real.
 *
 *   npm run live-hardening -- <McpEndpoint>
 *
 * Needs FARMASSIST_API_TOKEN (or .env.local), plus AWS credentials that can read the table
 * (AWS_PROFILE, default MyPersonalAWSAccount) and FARMASSIST_TABLE_NAME (default farmassist-dev).
 *
 * All entries are dated in January 2025 so they never show up in "today" or "this month" during a demo.
 * The pagination entries use fixed clientRequestIds, so running this again does not add more of them.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { existsSync } from 'node:fs';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const url = process.argv[2];
const token = process.env.FARMASSIST_API_TOKEN;
if (!url || !token) {
  console.error('Usage: npm run live-hardening -- <McpEndpoint>   (FARMASSIST_API_TOKEN must be set)');
  process.exit(1);
}
const tableName = process.env.FARMASSIST_TABLE_NAME ?? 'farmassist-dev';
const farmId = process.env.FARMASSIST_DEMO_FARM_ID ?? 'demo-farm';
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-south-1', credentials: fromIni({ profile: process.env.AWS_PROFILE ?? 'MyPersonalAWSAccount' }) }),
);

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: `Bearer ${token}`,
  'MCP-Protocol-Version': '2025-11-25',
};
let rpcId = 1;

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: any;
}

async function callTool(name: string, args: object): Promise<ToolResult> {
  const res = await fetch(url!, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (res.status !== 200) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  return body.result;
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

const runId = `live${Date.now()}`;

// 1. Five simultaneous retries of one request (same clientRequestId) create exactly one entry.
{
  const date = '2025-01-16';
  const args = { amountRupees: 432.1, category: 'fuel', date, note: `retry storm ${runId}`, clientRequestId: `${runId}-storm` };
  const results = await Promise.all(Array.from({ length: 5 }, () => callTool('record_expense', args)));
  const ok = results.filter((r) => !r.isError);
  const created = ok.filter((r) => r.structuredContent?.duplicate === false);
  const ids = new Set(ok.map((r) => r.structuredContent?.entry?.entryId));
  const page = await callTool('list_expenses', { from: date, to: date, category: 'fuel', limit: 50 });
  const stored = page.structuredContent.items.filter((e: { note?: string }) => e.note === args.note);
  check(
    '5 parallel retries with one clientRequestId -> one stored entry',
    created.length === 1 && ids.size === 1 && stored.length === 1,
    `${ok.length}/5 answered OK (${created.length} created, ${ok.length - created.length} duplicate), ${results.length - ok.length} asked to retry; ${stored.length} entry stored`,
  );
}

// 2. Five simultaneous corrections of one entry: optimistic locking keeps the version and the audit trail consistent.
{
  const created = await callTool('record_expense', { amountRupees: 800, category: 'medicine', date: '2025-01-17', note: `race ${runId}` });
  const entryId: string = created.structuredContent.entry.entryId;
  const amounts = [901, 902, 903, 904, 905];
  const results = await Promise.all(amounts.map((a) => callTool('correct_entry', { entryId, newAmountRupees: a, reason: `race ${a}` })));
  const corrected = results.filter((r) => r.structuredContent?.status === 'corrected');
  const refused = results.filter((r) => r.isError && /changed by another request/.test(r.content[0]!.text));
  const other = results.length - corrected.length - refused.length;

  const { Items: stored = [] } = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `FARM#${farmId}`, ':prefix': `EXP#2025-01-17#${entryId.split('_')[2]}` },
      ConsistentRead: true,
    }),
  );
  const { Items: audits = [] } = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `FARM#${farmId}`, ':prefix': `CORR#${entryId}#` },
      ConsistentRead: true,
    }),
  );
  const entry = stored[0]!;
  // The audit records must form an unbroken chain 800 -> ... -> final amount, one per version step.
  const chain = [...audits].sort((a, b) => a.fromVersion - b.fromVersion);
  const unbroken = chain.every((a, i) => a.fromVersion === i + 1 && a.toVersion === i + 2 && (i === 0 ? a.before.amountPaise === 80000 : a.before.amountPaise === chain[i - 1]!.after.amountPaise));
  check(
    '5 parallel corrections -> version, audit trail and final amount agree',
    corrected.length >= 1 &&
      other === 0 &&
      entry.version === 1 + corrected.length &&
      audits.length === corrected.length &&
      unbroken &&
      entry.amountPaise === chain.at(-1)!.after.amountPaise,
    `${corrected.length} corrected, ${refused.length} refused as concurrent, ${other} other; stored version ${entry.version}, ${audits.length} audit records, final ₹${entry.amountPaise / 100}`,
  );
}

// 3. Pagination over real DynamoDB pages: every entry exactly once, newest first, matching the server total.
{
  const date = '2025-01-15';
  for (let i = 0; i < 25; i++) {
    const r = await callTool('record_expense', { amountRupees: 10 + i, category: 'feed', date, note: `page seed ${i}`, clientRequestId: `live-page-seed-${String(i).padStart(2, '0')}` });
    if (r.isError) throw new Error(`seeding failed: ${r.content[0]!.text}`);
  }
  const seen: Array<{ entryId: string; date: string; amountPaise: number }> = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const r = await callTool('list_expenses', { from: '2025-01-01', to: '2025-01-31', limit: 10, ...(cursor ? { cursor } : {}) });
    seen.push(...r.structuredContent.items);
    cursor = r.structuredContent.nextCursor;
    pages++;
  } while (cursor && pages < 50);

  const summary = await callTool('get_expense_summary', { from: '2025-01-01', to: '2025-01-31' });
  const unique = new Set(seen.map((e) => e.entryId));
  const newestFirst = seen.every((e, i) => i === 0 || seen[i - 1]!.date >= e.date);
  const pageTotal = seen.reduce((sum, e) => sum + e.amountPaise, 0);
  check(
    'pagination returns every January entry once, newest first, adding up to the server total',
    unique.size === seen.length && newestFirst && seen.length === summary.structuredContent.entryCount && pageTotal === summary.structuredContent.totalPaise,
    `${seen.length} entries over ${pages} pages, ${unique.size} unique; listed total ${pageTotal} paise vs summary ${summary.structuredContent.totalPaise} (${summary.structuredContent.entryCount} entries)`,
  );
}

console.log(`\n${failures === 0 ? 'All live checks passed' : `${failures} live check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
