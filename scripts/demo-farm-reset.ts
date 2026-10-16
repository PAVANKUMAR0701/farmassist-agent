/**
 * Lists everything stored for one farm (default: the demo farm), and with --apply deletes it all, for a clean
 * start before recording a demo. Without --apply nothing is changed.
 *
 *   npm run demo-farm-reset                 # list only
 *   npm run demo-farm-reset -- --apply      # delete every item of the farm (cannot be undone)
 *
 * Uses AWS_PROFILE (default MyPersonalAWSAccount) and FARMASSIST_TABLE_NAME (default farmassist-dev).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const farmId = process.env.FARMASSIST_DEMO_FARM_ID ?? 'demo-farm';
const table = process.env.FARMASSIST_TABLE_NAME ?? 'farmassist-dev';
const apply = process.argv.includes('--apply');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1', credentials: fromIni({ profile: process.env.AWS_PROFILE ?? 'MyPersonalAWSAccount' }) }));

const keys: Array<{ PK: string; SK: string }> = [];
const byKind = new Map<string, number>();
let start: Record<string, unknown> | undefined;
do {
  const page = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `FARM#${farmId}` }, ProjectionExpression: 'PK, SK', ExclusiveStartKey: start }));
  for (const item of page.Items ?? []) {
    keys.push({ PK: item.PK, SK: item.SK });
    const kind = String(item.SK).split('#')[0]!;
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  start = page.LastEvaluatedKey;
} while (start);

const names: Record<string, string> = { EXP: 'expenses', ACT: 'activities', CORR: 'correction audit records', IDEM: 'retry markers', CONV: 'chat conversations', ANIMAL: 'animals', MILK: 'milk records', CROP: 'crop cycles', HARVEST: 'harvests', INSURANCE: 'insurance policies', REMINDER: 'reminders' };
console.log(`Farm "${farmId}" in table ${table}: ${keys.length} items`);
for (const [kind, n] of [...byKind].sort()) console.log(`  ${n}\t${names[kind] ?? kind}`);

if (!apply) {
  console.log('\nNothing was changed. Run with --apply to delete all of these items.');
} else {
  for (let i = 0; i < keys.length; i += 25) {
    let batch = { [table]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) } as Record<string, Array<{ DeleteRequest: { Key: Record<string, unknown> } }>>;
    for (let attempt = 0; attempt < 5 && Object.keys(batch).length; attempt++) {
      const result = await ddb.send(new BatchWriteCommand({ RequestItems: batch }));
      batch = (result.UnprocessedItems ?? {}) as typeof batch;
    }
  }
  console.log(`\nDeleted ${keys.length} items. The farm is empty.`);
}
