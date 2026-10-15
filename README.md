# FarmAssist Agent

> Talk to your farm ledger — every number verified, never guessed.

FarmAssist Agent is a voice-friendly farm ledger for small dairy and crop farmers in India. It is a **self-hosted MCP server** (Model Context Protocol, spec 2025-11-25, Streamable HTTP) for AWS Lambda and DynamoDB, with Amazon Bedrock planned for insights.

**Status: Phase 2 (AWS deployment) in progress.** The ledger tools below work locally and are covered by tests. The AWS SAM template and Lambda handler are written and checked (template lint, bundle build, handler tests), but **have not been deployed yet**. The Bedrock insights and the web client are still to come.

## Tools

| Tool | What it does |
|---|---|
| `record_expense` | Saves an expense (amount stored as whole paise). Retries with the same `clientRequestId` never create a duplicate. |
| `list_expenses` | Pages through expenses for a period, newest first. |
| `get_expense_summary` | Verified totals for a period, by category or by day. |
| `record_farm_activity` | Logs milking, vaccination, sowing, harvesting, irrigation, etc., per animal or field. |
| `correct_entry` | Fixes an expense ("no, it was ₹900") and keeps an audit record of the old value. |
| `get_daily_summary` | Everything recorded on one day: expense total, spending by category, all expenses and activities. |
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

## Deploy to AWS

What gets created ([template.yaml](template.yaml)):
- **Lambda** (Node.js 22, arm64) with a public **Function URL**. Access is controlled by the bearer token, which is checked in code.
- **DynamoDB** table, on-demand, with TTL, point-in-time recovery and encryption.
- **CloudWatch** log group with 14-day retention. Each request writes one JSON log line with its method, status and latency (never the request body).

You need the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) and working AWS credentials.

1. Store the bearer token as an SSM SecureString. CloudFormation cannot create SecureStrings, so this is a separate step. Use the same token as your `.env.local` or generate a new one:

   ```bash
   aws ssm put-parameter --region ap-south-1 --name /farmassist/dev/api-token --type SecureString --value "<token of 32+ characters>"
   ```

2. Build and deploy:

   ```bash
   sam build
   sam deploy --guided --region ap-south-1
   ```

   Accept the defaults or set `AllowedOrigins` to your web client's origin. `samconfig.toml` is git-ignored.

3. Run the smoke test against the `McpEndpoint` output:

   ```bash
   npm run smoke -- https://<id>.lambda-url.ap-south-1.on.aws/mcp
   ```

**Cost guards:** everything is pay-per-request. Set `ReservedConcurrency` (for example 5) to cap concurrent executions, but only if your account's concurrency limit is above 10. New accounts often have exactly 10, which leaves nothing to reserve.

**Teardown:** `sam delete` removes the function and logs. The DynamoDB table is kept on purpose (`DeletionPolicy: Retain`), so farm data can't be lost by accident. Delete it yourself once you no longer need it.

## About Alexa+

This project targets the Alexa+ track of the *Build, Ship, Shape* hackathon. Amazon's Alexa+ add-on tools (CLI, MCP Toolkit, Web Simulator) are partner-only, so this project is **not** connected to a real Alexa+ device or console. It is shown through its own web-based MCP client instead. See [FRICTION.md](FRICTION.md).

## License

[MIT](LICENSE)
