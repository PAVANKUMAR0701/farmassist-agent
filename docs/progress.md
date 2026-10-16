# Progress

Each step is marked done only after its checks pass. Evidence is linked or summarised next to it.

## Step 0: Repository audit — done (2026-10-16)

- Branch `main`, last commit `e4759f6`. One uncommitted change (FRICTION #5, Bedrock Marketplace subscription), kept as it was.
- `npm run typecheck`: clean. `npm test`: 170 tests in 15 files pass. `npm run build:lambda`: bundle builds.
- `sam validate --lint`: valid template.

## Step 1: Deploy the backend — done (2026-10-16)

- AWS identity: account 381492152939 (profile `MyPersonalAWSAccount`), region ap-south-1.
- Cost guards: a $1 monthly budget and a zero-spend budget already exist. Everything is pay-per-request. The account concurrency limit is 10, so `ReservedConcurrency` stays at 0 (unset).
- 1a. SSM SecureString `/farmassist/dev/api-token` created (same token as `.env.local`, 43 characters).
- 1b. `sam build` (needed the project's esbuild on the PATH, see README).
- 1c. `sam deploy`: stack `farmassist-dev`, `CREATE_COMPLETE`. Bedrock parameters left empty.
- 1d. Smoke test against the live Function URL: 19/19 pass. DynamoDB contents, audit record, IAM policy, table settings and logs checked by hand. See [protocol-tests.md](protocol-tests.md#recorded-result-deployed-to-aws-2026-10-16).

Teardown: `sam delete --stack-name farmassist-dev --region ap-south-1`, then delete the table `farmassist-dev` and the SSM parameter by hand (both are kept on purpose).

## Step 2: Harden the backend and MCP contract — done (2026-10-16)

- Reviewed every tool's input and output schema. Inputs were already strict (bounded strings, amount limits, enum categories, real-calendar dates, cursors bound to their query and farm), so no schema changes were needed.
- Already covered before this step: IST midnight boundaries, period edge cases, cursor tampering, two-farm isolation, optimistic locking, idempotency conflicts, hidden storage errors (every tool goes through `runTool`), and 401/403/405/406/400 protocol errors.
- Added `tests/protocol/contract-hardening.test.ts` (19 tests): ignored `farmId` arguments, malformed arguments, unknown tool or method, non-JSON-RPC bodies, JSON-RPC batch limits.
- **Defect fixed:** a DynamoDB `TransactionConflict` during simultaneous retries or corrections surfaced as a generic server error. Reproduced on the live table, fixed, covered by 3 new unit tests, redeployed and re-verified. See [protocol-tests.md](protocol-tests.md#live-concurrency-and-pagination-checks-2026-10-16).
- Added `scripts/live-hardening.ts` (`npm run live-hardening`): concurrency and pagination against real DynamoDB.
- Checks: typecheck clean, 192 tests in 16 files pass, Lambda bundle builds, live smoke test 19/19, live hardening checks pass 3 runs in a row.
- Data model unchanged. No migration.

## Step 3: MCP client/agent and model adapter (Nova Lite first) — done, except a live model call (2026-10-16)

- `src/agent/mcp-client.ts`: official MCP SDK client over Streamable HTTP with the bearer token. Handles tool discovery (schemas as published by the server), tool calls, and results normalised to text plus structured data.
- `src/agent/model.ts`: provider-neutral `AgentModel` interface, with a Bedrock Converse implementation. The model is chosen by `AGENT_MODEL_ID` only. `src/services/bedrock-client.ts` now picks the Bedrock account the same way for the agent and `weekly_insights` (own role, cross-account role, or local profile).
- `src/agent/agent.ts`: conversation state, tool loop with a 4-round limit, a `clientRequestId` added to every write, one retry (same id) on transport errors, and a number check on model replies (an unverified number means the reply is replaced with server text). If the model fails it falls back to the parser, but only if nothing was written that turn, so a write is never repeated.
- `src/agent/fallback.ts`: deterministic parser for expenses, activities, corrections of the last expense, spending questions, daily summaries, lists and weekly insights. It asks a question when the amount or category is missing.
- `npm run agent`: CLI for one conversation against any endpoint.
- Tests: 31 new (223 in total, 19 files). The agent tests use the real SDK client against the real server in-process, so they cover the client/server contract and the ledger state, not a fake.
- End to end against the deployed stack, no model: recorded ₹2,500 of feed, corrected it to ₹900, recorded a vaccination and summarised the day. DynamoDB shows the expense at version 2 with a `CORR#` audit item (250000 → 90000 paise, the farmer's words as the reason) and the `ACT#` item.
- End to end with `AGENT_MODEL_ID=apac.amazon.nova-lite-v1:0` through the Bedrock account: the real `AccessDeniedException` was caught, and the fallback answered correctly.
- **Not done:** a successful live model call, and the Nova Lite vs Nova Micro quality comparison. Both are blocked on access (see [bedrock-access.md](bedrock-access.md)). Re-run `npm run agent` with `AGENT_MODEL_ID` set once the admin adds the policy.

Model access check, 2026-10-16, personal account, ap-south-1: the `apac.amazon.nova-lite-v1:0` and `apac.amazon.nova-micro-v1:0` inference profiles are listed, but the first `converse` call to each fails with `ThrottlingException: Too many tokens per day`. Service Quotas shows every Nova Lite, Nova Micro and Nova 2 Lite quota at 0, and the per-day token quotas are marked not adjustable. Raising them needs an AWS Support case. The Bedrock account (231427841372) is blocked too, see bedrock-access.md.

## Step 4: Web client — not started
## Step 5: Voice — not started
## Step 6: Weekly insights on the chosen model — not started
## Step 7: Multimodal retrieval — not started
## Step 8: Crop and cattle image analysis — not started
## Step 9: Release readiness — not started
