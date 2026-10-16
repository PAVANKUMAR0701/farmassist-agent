# FarmAssist Agent

> Talk to your farm ledger — every number verified, never guessed.

FarmAssist Agent is a voice-friendly farm ledger for small dairy and crop farmers in India. It is a **self-hosted MCP server** (Model Context Protocol, spec 2025-11-25, Streamable HTTP) for AWS Lambda and DynamoDB, with Amazon Bedrock planned for insights.

**Status: in progress.** All tools below work locally and are covered by tests, including `weekly_insights` and its number guard, which run against a mocked Bedrock. The backend is **deployed to AWS** (stack `farmassist-dev`, ap-south-1) and passes the full smoke test against the live endpoint ([recorded result](docs/protocol-tests.md#recorded-result-deployed-to-aws-2026-10-16)). It runs without any LLM: Bedrock is not switched on yet, so `weekly_insights` uses its template text. **No real Bedrock call has been tested yet.** The MCP client/agent works against the deployed backend, with Amazon Nova Lite or without any model. The web client is still to come. Progress is tracked in [docs/progress.md](docs/progress.md).

## Tools

| Tool | What it does |
|---|---|
| `record_expense` | Saves an expense (amount stored as whole paise). Retries with the same `clientRequestId` never create a duplicate. |
| `list_expenses` | Pages through expenses for a period, newest first. |
| `get_expense_summary` | Verified totals for a period, by category or by day. |
| `record_farm_activity` | Logs milking, vaccination, sowing, harvesting, irrigation, etc., per animal or field. |
| `correct_entry` | Fixes an expense ("no, it was ₹900") and keeps an audit record of the old value. |
| `get_daily_summary` | Everything recorded on one day: expense total, spending by category, all expenses and activities. |
| `weekly_insights` | Plain-language explanation of the last 7 days, written by Amazon Bedrock from figures calculated in code. Every number is checked by the [verified-number guard](docs/number-guard.md). |
| `list_activities` | Lists farm activities for a period, newest first. |
| `register_animal` / `update_animal` / `list_animals` | Herd register: add animals (several in one call), rename, set breed, tag, mother or birth date, mark sold or died. Counts and ages are worked out by code. |
| `record_milk` / `get_milk_summary` | Milk per animal or for the herd, morning or evening, stored as whole millilitres. Totals and the average per day come from code. |
| `record_sowing` / `record_harvest` / `list_crops` | Crop cycles (paddy, ragi, sugarcane, ...): field, acres, seed, harvests in kg, quintal or tonne, yield per acre and harvest-to-seed ratio. |
| `add_insurance` / `add_reminder` / `complete_reminder` / `list_reminders` | Animal insurance and reminders. Policy end dates show up as reminders 30 days ahead. |
| `health_check` | Confirms the server is reachable. |

All totals are added up by server code, and "today" or "this month" is worked out on the server in India time. The farm ID comes only from the bearer token. See [docs/data-model.md](docs/data-model.md).

## Run it locally

Requires Node.js 22 (22.19 or newer recommended, because MCP Inspector needs it).

```bash
npm ci
cp .env.example .env.local   # then set FARMASSIST_API_TOKEN
npm test                     # unit, protocol and Lambda handler tests
npm run start:local          # serves http://127.0.0.1:3000/mcp (in-memory storage)
```

In a second terminal:

```bash
npm run smoke -- http://127.0.0.1:3000/mcp
```

See [docs/protocol-tests.md](docs/protocol-tests.md) for what the smoke test checks and recorded results.

## Talk to it through the agent

`src/agent/` is the MCP client side. It connects to the server with the official MCP SDK client, discovers the tools, and turns a farmer's message into tool calls:

- **With a model** (`AGENT_MODEL_ID`, any Bedrock model that supports tool use through the Converse API, such as Amazon Nova Lite): the usual tool-use loop. The agent adds a `clientRequestId` to every write, so retries never double-record. A reply that contains a number not found in the tool results is replaced with the server's own text.
- **Without a model, or when the model fails:** a deterministic parser handles the core commands ("spent 2500 on feed", "no, it was 900", "vaccinated the brown cow", "how much on feed this month", "today's summary", "weekly insights"). It asks a question instead of guessing.

```bash
FARMASSIST_MCP_URL=https://<id>.lambda-url.ap-south-1.on.aws/mcp npm run agent -- "spent 2500 on feed" "no, it was 900"
```

**Amazon Nova Lite** is the chosen model (32 of 33 evaluation turns correct, median 1.5 s; Nova Micro scored 8/33). See [docs/model-evaluation.md](docs/model-evaluation.md) and, for account setup, [docs/bedrock-access.md](docs/bedrock-access.md).

## Web client

A mobile-first web app (`web/`, plain TypeScript, no framework, about 13 KiB) with sign-in, **Chat**, **Today** (dashboard), **Expenses** and **Activities**. It is served by the chat Lambda (`src/chat/`), which also hosts the agent. The page and the API share one origin, so no CORS is needed and no extra hosting service is involved.

- **Sign-in** uses Amazon Cognito. Accounts are created by an admin, and each has a `custom:farmId` the user cannot change. The backend takes the farm only from the verified ID token.
- **The browser never holds AWS credentials or the MCP token.** The chat backend checks the Cognito token, then acts as an MCP client to the MCP server.
- **Screens show only server-calculated amounts.** They call read-only MCP tools through `/api/read`. Writes go only through the agent.
- **Without a model** (or when Bedrock fails) the chat works in "basic mode" through the deterministic parser.

**Voice.** Tap 🎤 and speak in English (India), Hindi or Tamil. This uses the browser's built-in Web Speech API, with no extra service: speech input works in Chrome (Android and desktop), Edge and Safari, and elsewhere the mic is hidden and typing works. Replies are read aloud ("₹2,500.00" is spoken as "2,500 rupees"). Because speech can be misheard, **a spoken change is never saved straight away.** The app reads back exactly what it will save ("Shall I record ₹2,500.00 on feed for today?"), then listens for "yes"/"haan"/"aama" or a tap on **Yes, save**. The read-back is built by code from the exact tool arguments, not written by the model. If the microphone is blocked, missing or hears nothing, the app says so and typing still works.

Run it locally (local dev sign-in, in-memory data, bound to 127.0.0.1 only):

```bash
npm run build:web
npm run start:chat   # http://127.0.0.1:5173
```

**Create a sign-in user** after deploying (`UserPoolId` is a stack output). Pick your own temporary password; the app asks for a new one at first sign-in:

```bash
aws cognito-idp admin-create-user --region ap-south-1 --user-pool-id <UserPoolId> --username <username> --user-attributes Name=name,Value="<Display name>" Name=custom:farmId,Value=demo-farm --temporary-password "<temporary password, 8+ chars with a number>" --message-action SUPPRESS
```

## Deploy to AWS

What gets created ([template.yaml](template.yaml)):
- **MCP Lambda** (Node.js 22, arm64) with a public **Function URL**. Access is controlled by the bearer token, which is checked in code.
- **Chat Lambda** with its own Function URL. It serves the web client and the agent API, and checks Cognito ID tokens in code.
- **Cognito user pool** for web sign-in (admin-created users only).
- **DynamoDB** table, on-demand, with TTL, point-in-time recovery and encryption.
- **CloudWatch** log group with 14-day retention. Each request writes one JSON log line with its method, status and latency (never the request body).

You need the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) and working AWS credentials.

1. Store the bearer token as an SSM SecureString. CloudFormation cannot create SecureStrings, so this is a separate step. Use the same token as your `.env.local` or generate a new one:

   ```bash
   aws ssm put-parameter --region ap-south-1 --name /farmassist/dev/api-token --type SecureString --value "<token of 32+ characters>"
   ```

2. Build and deploy (`npm run build:web` first, because the chat Lambda bundles the web client):

   ```bash
   npm run build:web
   sam build
   sam deploy --guided --region ap-south-1
   ```

   Accept the defaults or set `AllowedOrigins` to your web client's origin. `samconfig.toml` is git-ignored.

   If `sam build` fails with "Cannot find esbuild", put the project's own esbuild on the PATH for that shell first. In PowerShell: `$env:PATH = "$PWD\node_modules\.bin;$env:PATH"`.

   Non-interactive equivalent of the guided deploy:

   ```bash
   sam deploy --stack-name farmassist-dev --region ap-south-1 --resolve-s3 --capabilities CAPABILITY_IAM --no-confirm-changeset --no-fail-on-empty-changeset
   ```

3. Run the smoke test against the `McpEndpoint` output:

   ```bash
   npm run smoke -- https://<id>.lambda-url.ap-south-1.on.aws/mcp
   ```

   `npm run live-hardening -- <same URL>` also checks simultaneous retries, simultaneous corrections and pagination against the real table (needs AWS credentials that can read it). See [docs/protocol-tests.md](docs/protocol-tests.md).

**Bedrock (optional):** set `BedrockModelId` (for example `in.anthropic.claude-haiku-4-5-20251001-v1:0`) to turn on Bedrock narration in `weekly_insights`. Leave it empty and the tool uses template text built from the same verified figures. If Bedrock runs in a different AWS account, also set `BedrockRoleArn`. The function then has permission only to assume that one role, and that role must trust the `FunctionRoleArn` stack output. For local runs, set `BEDROCK_MODEL_ID` and optionally `BEDROCK_AWS_PROFILE` in `.env.local` (see `.env.example`).

**Cost guards:** everything is pay-per-request. Set `ReservedConcurrency` (for example 5) to cap concurrent executions, but only if your account's concurrency limit is above 10. New accounts often have exactly 10, which leaves nothing to reserve.

**Teardown:** `sam delete` removes the function and logs. The DynamoDB table is kept on purpose (`DeletionPolicy: Retain`), so farm data can't be lost by accident. Delete it yourself once you no longer need it.

## About Alexa+

This project targets the Alexa+ track of the *Build, Ship, Shape* hackathon. Amazon's Alexa+ add-on tools (CLI, MCP Toolkit, Web Simulator) are partner-only, so this project is **not** connected to a real Alexa+ device or console. It is shown through its own web-based MCP client instead. See [FRICTION.md](FRICTION.md).

## License

[MIT](LICENSE)
