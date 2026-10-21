/**
 * Imports the Krishna Farm demo data (synthetic, not real farm records) into DynamoDB. Without --apply it only
 * checks the seed file and prints what it would write. Re-running it is safe: every record has a stable id, so
 * the same items are rewritten (upsert) and nothing is duplicated. The farm's other records are not touched.
 *
 *   npm run seed-krishna-farm                         # check only
 *   npm run seed-krishna-farm -- --apply              # write to farm KRISHNA-FARM in farmassist-dev
 *   npm run seed-krishna-farm -- --apply --farm demo-farm
 *
 * Options: --file <seed.json> (default data/krishna-farm/krishna_farm_demo_seed.json), --farm <farmId>.
 * Uses AWS_PROFILE (default MyPersonalAWSAccount) and FARMASSIST_TABLE_NAME (default farmassist-dev); only a
 * table whose name ends in "-dev" or "-demo" is written, so production data is never overwritten by accident.
 */
import { readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FARM_ID_PATTERN } from '../src/auth/cognito-farm.js';
import { applyImportPlan, checkKrishnaSeed, countPlan, planKrishnaImport } from '../src/demo/krishna-farm.js';
import { DynamoLedgerRepository } from '../src/repositories/dynamodb-ledger-repository.js';
import { DynamoRecordStore } from '../src/repositories/dynamodb-record-store.js';
import type { RecordKind } from '../src/repositories/record-store.js';

const option = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const file = option('--file') ?? 'data/krishna-farm/krishna_farm_demo_seed.json';
const apply = process.argv.includes('--apply');
const table = process.env.FARMASSIST_TABLE_NAME ?? 'farmassist-dev';

const check = checkKrishnaSeed(JSON.parse(readFileSync(file, 'utf8')));
for (const w of check.warnings) console.log(`warning: ${w}`);
if (!check.seed) {
  for (const e of check.errors) console.error(`error: ${e}`);
  console.error(`\n${check.errors.length} problems in ${file}. Nothing was written.`);
  process.exit(1);
}
const farmId = option('--farm') ?? check.seed.farm.farm_id;
if (!FARM_ID_PATTERN.test(farmId)) throw new Error(`Invalid farm id ${farmId}`);
const plan = planKrishnaImport(check.seed, farmId);
const counts = countPlan(plan);
console.log(`${check.seed.metadata.data_classification}`);
console.log(`Seed ${file} (as of ${check.seed.farm.as_of_date}) for farm "${farmId}" in table ${table}:`);
for (const [kind, n] of Object.entries(counts)) console.log(`  ${n}\t${kind}`);

if (!apply) {
  console.log('\nChecked only; nothing was written. Run with --apply to import.');
  process.exit(0);
}
if (!/-(dev|demo)$/.test(table)) throw new Error(`Refusing to write demo data to table ${table}: only *-dev or *-demo tables`);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1', credentials: fromIni({ profile: process.env.AWS_PROFILE ?? 'MyPersonalAWSAccount' }) }));
const records = new DynamoRecordStore(client, table);
const ledger = new DynamoLedgerRepository(client, table);
const written = await applyImportPlan(plan, { records, ledger });
console.log(`\nWrote ${written} items (upserts).`);

// Read back what is stored for the farm and compare with the plan: every planned id must be there.
let missing = 0;
for (const kind of Object.keys(counts).filter((k) => k !== 'expense') as RecordKind[]) {
  const stored = new Set((await records.list(farmId, kind)).map((r) => r.id));
  const planned = plan.records.filter((r) => r.kind === kind);
  const absent = planned.filter((r) => !stored.has(r.id)).length;
  missing += absent;
  console.log(`  ${kind}: ${planned.length} planned, ${stored.size} stored for the farm${absent ? `, ${absent} MISSING` : ''}`);
}
const storedExpenses = new Set((await ledger.getAllExpenses({ farmId, from: '0000-01-01', to: '9999-12-31' })).map((e) => e.entryId));
const absentExpenses = plan.expenses.filter((e) => !storedExpenses.has(e.entryId)).length;
missing += absentExpenses;
console.log(`  expense: ${plan.expenses.length} planned, ${storedExpenses.size} stored for the farm${absentExpenses ? `, ${absentExpenses} MISSING` : ''}`);
if (missing) {
  console.error(`\n${missing} planned items were not found after the import.`);
  process.exit(1);
}
console.log('\nVerified: every planned item is stored.');
