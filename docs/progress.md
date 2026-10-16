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

## Step 3: MCP client/agent and model adapter (Nova Lite first) — done (2026-10-16)

- `src/agent/mcp-client.ts`: official MCP SDK client over Streamable HTTP with the bearer token. Handles tool discovery (schemas as published by the server), tool calls, and results normalised to text plus structured data.
- `src/agent/model.ts`: provider-neutral `AgentModel` interface, with a Bedrock Converse implementation. The model is chosen by `AGENT_MODEL_ID` only. `src/services/bedrock-client.ts` now picks the Bedrock account the same way for the agent and `weekly_insights` (own role, cross-account role, or local profile).
- `src/agent/agent.ts`: conversation state, tool loop with a 4-round limit, a `clientRequestId` added to every write, one retry (same id) on transport errors, and a number check on model replies (an unverified number means the reply is replaced with server text). If the model fails it falls back to the parser, but only if nothing was written that turn, so a write is never repeated.
- `src/agent/fallback.ts`: deterministic parser for expenses, activities, corrections of the last expense, spending questions, daily summaries, lists and weekly insights. It asks a question when the amount or category is missing.
- `npm run agent`: CLI for one conversation against any endpoint.
- Tests: 31 new (223 in total, 19 files). The agent tests use the real SDK client against the real server in-process, so they cover the client/server contract and the ledger state, not a fake.
- End to end against the deployed stack, no model: recorded ₹2,500 of feed, corrected it to ₹900, recorded a vaccination and summarised the day. DynamoDB shows the expense at version 2 with a `CORR#` audit item (250000 → 90000 paise, the farmer's words as the reason) and the `ACT#` item.
- End to end with `AGENT_MODEL_ID=apac.amazon.nova-lite-v1:0` through the Bedrock account: the real `AccessDeniedException` was caught, and the fallback answered correctly.
- Live models: the Bedrock account's admin added the Nova policy, and Nova Lite and Nova Micro both answer. `npm run agent-eval` (11 cases × 3 runs against the deployed backend): **Nova Lite 32/33, median 1.5 s per turn; Nova Micro 8/33** (markdown in replies, wrong week). **Nova Lite is the agent model.** Eight agent issues found by the evaluation were fixed. See [model-evaluation.md](model-evaluation.md).
- Live end to end with Nova Lite: "paid 1750 to the labourer on 2025-01-23", then "no, it was 1500". DynamoDB shows the labour expense at 150000 paise, version 2, with a `CORR#` audit item of 175000 → 150000.

Model access check, 2026-10-16, personal account, ap-south-1: the `apac.amazon.nova-lite-v1:0` and `apac.amazon.nova-micro-v1:0` inference profiles are listed, but the first `converse` call to each fails with `ThrottlingException: Too many tokens per day`. Service Quotas shows every Nova Lite, Nova Micro and Nova 2 Lite quota at 0, and the per-day token quotas are marked not adjustable. Raising them needs an AWS Support case. The Bedrock account (231427841372) is blocked too, see bedrock-access.md.

## Step 4: Web client and hosted chat backend — done (2026-10-16)

- `list_activities` MCP tool (read-only), since activities were only visible in daily summaries.
- `src/chat/`: hosted chat backend. It verifies Cognito ID tokens (`aws-jwt-verify`; the farm comes only from the immutable `custom:farmId` claim), stores conversation state per farm and user in the ledger table (`CONV#`, 24 h TTL), runs the agent as an MCP client of the MCP Lambda, and allows only read-only tools on `/api/read`. Responses carry a strict CSP, `X-Frame-Options: DENY` and `nosniff`.
- `web/`: mobile-first client (13 KiB, no framework). It has sign-in (including the first-sign-in new-password step and token refresh), Chat with suggestion chips and a "basic mode" badge, a Today dashboard, Expenses (period and category filters, "show more" paging, server total) and Activities. Error states cover offline, an expired session (back to sign-in), unreachable server (retry), empty lists and an unlinked farm.
- `template.yaml`: Cognito user pool and client, chat function with its own URL, and `AgentModelId` / `AgentBedrockRoleArn` parameters. The chat role can only Get/Put on the table (for conversations), read the one SSM parameter, and optionally assume the one Bedrock role.
- Tests: 245 in 21 files (14 new chat-backend tests: auth boundaries, validation, conversation continuity and per-user isolation, the read-only allowlist, 502 mapping, CSP, conversation TTL). Checked in the browser at 375×812 against the local server: sign-in, chat (record, correct across requests, activity, clarifying question), Today, Expenses and Activities. Three UI defects found there were fixed (newest reply hidden under the composer, duplicated action line, animal names lowercased).
- Deployed: `WebAppUrl` serves the app (sign-in screen loads, no console errors). The API returns 401 without a token and with a forged one. The MCP smoke test is still 19/19.
- Live, signed in on a phone: the Cognito user `pavan` (created by the owner) signed in, changed the temporary password, and chatted. Basic mode stored "Spent 2500 on cattle feed" (250000 paise) and the conversation under the user's own `sub`. After a redeploy with `AgentModelId=apac.amazon.nova-lite-v1:0` and `AgentBedrockRoleArn=…:role/Pavan_BedRock_MCP_Role`, chats were answered by **Nova Lite through the cross-account role** (no basic-mode label, no Bedrock errors in the logs, 1.7–4.9 s per turn).
- **Live bug found and fixed:** asked to name Lakshmi's new calf "Seetha", Nova Lite tried to edit the saved activity. The server rightly refused, but the reply claimed "has been updated". The fix is a deterministic `claimsSuccess` guard (a success claim after only failed writes is replaced by "Nothing was saved." plus the server's reason) and prompt guidance to add details as a new activity. Covered by unit tests replaying the exact exchange and by a new evaluation case (3/3). Nova Lite overall 34/36. Redeployed. Retested live on the phone: the guard replaced a false claim with "Nothing was saved. …", and the retry recorded the calf's name as a new activity. The server's refusal now tells the model to record a new activity, and a fresh-chat evaluation case was added: **Nova Lite 39/39**.
- **Before recording the demo:** today's demo-farm data includes smoke-test entries (three ₹2,500 feed, three ₹900 medicine, three vaccinations) and one ₹700 "other" written by an early evaluation run. Remove them, or use a fresh `DemoFarmId`, so the dashboard shows only demo entries.
## Step 5: Voice — not started
## Step 6: Weekly insights on the chosen model — not started
## Step 7: Multimodal retrieval — not started
## Step 8: Crop and cattle image analysis — not started
## Step 9: Release readiness — not started
