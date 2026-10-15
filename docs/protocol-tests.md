# MCP protocol tests

The server must follow the [Streamable HTTP transport rules in MCP spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). We check this in three ways:

1. **Automated tests:** `tests/protocol/streamable-http.test.ts` runs in `npm test` and in GitHub Actions. It calls the handler in-process, without a network.
2. **Raw HTTP smoke test:** `npm run smoke -- <url>` sends real HTTP requests with plain `fetch` (no MCP SDK) to a running server, local or deployed.
3. **Official MCP Inspector (CLI mode)**

## Design decisions

| Spec rule | Our behaviour | Why |
|---|---|---|
| Sessions are optional (MAY) | Stateless: no `MCP-Session-Id` | Any Lambda instance can answer any request |
| Server may answer a request with JSON or SSE | Always JSON (`enableJsonResponse`) | Lambda responses are buffered; we have no streaming needs |
| GET: return an SSE stream **or 405** | 405 + `Allow: POST` | No server-initiated messages |
| DELETE may return 405 | 405 | No sessions to end |
| Present but invalid `Origin` → 403 | 403, checked in our code before the SDK | The SDK's built-in origin option is deprecated |
| Notifications → 202, no body | SDK transport | |
| Unsupported `MCP-Protocol-Version` → 400 | SDK transport | |
| POST `Accept` must list both JSON and SSE | SDK transport returns 406 otherwise | |

## Recorded result: local server, 2026-10-14

```
MCP protocol smoke test against http://127.0.0.1:3000/mcp

PASS  initialize  (HTTP 200, expected 200)
PASS  notifications/initialized -> 202  (HTTP 202, expected 202)
PASS  tools/list  (HTTP 200, expected 200)
PASS  tools/call health_check  (HTTP 200, expected 200)
PASS  GET -> 405  (HTTP 405, expected 405)
PASS  DELETE -> 405  (HTTP 405, expected 405)
PASS  bad Origin -> 403  (HTTP 403, expected 403)
PASS  unsupported MCP-Protocol-Version -> 400  (HTTP 400, expected 400)
PASS  Accept without text/event-stream -> 406  (HTTP 406, expected 406)

9/9 checks passed
```

The `initialize` response was `"protocolVersion":"2025-11-25"`, with `serverInfo.name` `farmassist-agent`.

MCP Inspector 2.11.0 (CLI mode):

```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http --method tools/list
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http --method tools/call --tool-name health_check
```

Both returned the expected tool list and `structuredContent` (`"status":"ok"`, `"todayInFarmTimeZone":"2026-10-14"`).

## Recorded result: local server with bearer auth and `record_expense`, 2026-10-14

```
PASS  initialize  (HTTP 200, expected 200)
PASS  notifications/initialized -> 202  (HTTP 202, expected 202)
PASS  tools/list  (HTTP 200, expected 200)
PASS  tools/call record_expense  (HTTP 200, expected 200)
PASS  tools/call record_expense again (same clientRequestId) -> duplicate  (HTTP 200, expected 200)
PASS  tools/call record_expense invalid category -> isError  (HTTP 200, expected 200)
PASS  missing bearer token -> 401  (HTTP 401, expected 401)
PASS  GET -> 405  (HTTP 405, expected 405)
PASS  DELETE -> 405  (HTTP 405, expected 405)
PASS  bad Origin -> 403  (HTTP 403, expected 403)
PASS  unsupported MCP-Protocol-Version -> 400  (HTTP 400, expected 400)
PASS  Accept without text/event-stream -> 406  (HTTP 406, expected 406)

12/12 checks passed
```

Over the network, every request now needs `Authorization: Bearer <token>`. Without it the server returns 401 with no `WWW-Authenticate` header. Order of checks: Origin (403), then method (405), then auth (401), then the SDK transport.

MCP Inspector, with the token:

```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http --header "Authorization: Bearer <token>" --method tools/call --tool-name record_expense --tool-arg amountRupees=800 --tool-arg category=medicine --tool-arg "note=cow medicine"
```

Result: `"amountPaise": 80000, "amountDisplay": "₹800.00", "duplicate": false`.

## Recorded result: with `list_expenses` and `get_expense_summary`, 2026-10-14

```
PASS  initialize  (HTTP 200, expected 200)
PASS  notifications/initialized -> 202  (HTTP 202, expected 202)
PASS  tools/list  (HTTP 200, expected 200)
PASS  tools/call record_expense  (HTTP 200, expected 200)
PASS  tools/call record_expense again (same clientRequestId) -> duplicate  (HTTP 200, expected 200)
PASS  tools/call get_expense_summary (feed, this month) includes the ₹2,500  (HTTP 200, expected 200)
PASS  tools/call list_expenses returns the smoke-test entry  (HTTP 200, expected 200)
PASS  tools/call record_expense invalid category -> isError  (HTTP 200, expected 200)
PASS  missing bearer token -> 401  (HTTP 401, expected 401)
PASS  GET -> 405  (HTTP 405, expected 405)
PASS  DELETE -> 405  (HTTP 405, expected 405)
PASS  bad Origin -> 403  (HTTP 403, expected 403)
PASS  unsupported MCP-Protocol-Version -> 400  (HTTP 400, expected 400)
PASS  Accept without text/event-stream -> 406  (HTTP 406, expected 406)

14/14 checks passed
```

`get_expense_summary {"period":"this_month","category":"feed"}` replied: `Spent ₹2,500.00 on feed from 2026-10-01 to 2026-10-14 (1 entry).` with `"totalPaise": 250000` and `"calculatedBy": "server"`.

## Recorded result: with `get_daily_summary`, 2026-10-15

Local server, in-memory storage. The new check confirms that the daily summary shows the corrected ₹900 (not the original ₹800) and the vaccination.

```
PASS  tools/call correct_entry ₹800 -> ₹900 (before/after)  (HTTP 200, expected 200)
PASS  tools/call get_daily_summary (today) includes the corrected ₹900 and the vaccination  (HTTP 200, expected 200)
...
18/18 checks passed
```

## Lambda Function URL handler

`tests/lambda/handler.test.ts` runs the Lambda entry point (`src/lambda/handler.ts`) with Function URL events, mocking SSM and DynamoDB. It checks `initialize`, `tools/list`, base64 bodies, 202 for notifications, 401/403/405/404, and that a failed token load returns 500 and is retried on the next request.

The deployed AWS endpoint has not been tested yet. Once deployed, run `npm run smoke -- <McpEndpoint>` and record the result here.
