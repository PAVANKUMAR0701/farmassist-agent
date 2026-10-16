# Friction log

Real problems hit while building FarmAssist Agent, recorded as they happen. Times are IST (UTC+05:30). "approx." means the time was reconstructed shortly afterwards rather than noted live.

Severity: **low** (annoying), **medium** (cost real time), **high** (forced a design change), **blocker** (stopped the work).

---

### 1. Alexa AI CLI is not installable by hackathon participants
- **When:** 2026-10-14 12:47
- **Task:** Install the Alexa AI CLI to test whether a real Alexa+ MCP add-on is possible.
- **Expected:** The "Set Up Your Development Environment" page gives `npm install -g @alexa-ai/cli`, so it should install.
- **Actual:** `npm view @alexa-ai/cli version` returns `E404 Not Found`. The setup page says the package comes from a private CodeArtifact registry, reached through an AWS account registered with an Alexa Solutions Architect, and lists only macOS and Ubuntu. Neither the setup page nor the quickstart says the tools are partner-only. The hackathon FAQ confirms participants cannot get access.
- **Severity:** high (decided the demo architecture)
- **Workaround:** Build a self-hosted MCP server and demo it through our own web MCP client, the path the hackathon FAQ approves.
- **Suggestion:** Put a "partner-only preview" banner on every Alexa+ add-on setup page, not only the docs home page.

### 2. New AWS account: Bedrock blocked by account verification
- **When:** 2026-10-14 approx. 13:15
- **Task:** Bedrock Converse tool-use smoke test (Claude Haiku 5.5 and Amazon Nova 2 Lite) in ap-south-1.
- **Expected:** `get-foundation-model-availability` had just reported both models as `AUTHORIZED` and `AVAILABLE`, so the call should work.
- **Actual:** `AccessDeniedException: Your account is currently being verified...` for both models.
- **Severity:** medium
- **Workaround:** Built the local MCP server first. Verification finished within a few hours.
- **Suggestion:** Have the model-availability API report account-verification status, so "AVAILABLE" isn't misleading.

### 3. New AWS account: Bedrock daily token quotas are 0, plus the Anthropic use-case form
- **When:** 2026-10-14 approx. 17:45
- **Task:** Retry the Bedrock smoke test after verification.
- **Expected:** At least one cheap tool-use model is callable.
- **Actual:**
  - `global.anthropic.claude-haiku-5-5`: `AccessDeniedException ... is not available for this account`.
  - `global.amazon.nova-2-lite-v1:0`: `ThrottlingException: Too many tokens per day`. Service Quotas shows `Global cross-region model inference tokens per day for Amazon Nova 2 Lite = 0`, marked not adjustable. Most per-day token quotas on this account are 0.
  - `in.anthropic.claude-haiku-4-5-20251001-v1:0`: `ResourceNotFoundException: Model use case details have not been submitted for this account`.
- **Update 2026-10-14 approx. 18:25:** Submitted the Anthropic use-case form (Bedrock console → Model catalog → Claude Haiku 5.5). About 15 minutes later Claude Haiku 4.5 moved on to the next error: `ThrottlingException: Too many tokens per day`. Service Quotas shows its cross-region requests/tokens per minute as **0 (adjustable)**. Haiku 5.5 still says "not available for this account".
- **Update 2026-10-14 approx. 18:45:** Tried `aws service-quotas request-service-quota-increase` for L-CCA5DF70 (to 20 requests/min) and L-58BE175A (to 50,000 tokens/min). Both were rejected: `You must provide a quota value greater than the default quota value of 10000.0` (and `5000000.0`). The account's *applied* value is 0 while the *default* is 10,000, so the self-service quota tool cannot restore it. An AWS Support case is needed.
- **Severity:** medium (open; Bedrock work is scheduled for Oct 17)
- **Workaround:** Submit the Anthropic use-case form in the Bedrock console; open an AWS Support quota case if needed; mock Bedrock in unit tests (as the hackathon FAQ suggests).
- **Suggestion:** One page listing everything a new account must do before its first Bedrock call (verification, use-case form, per-day quotas). The three errors arrived one after another.

### 4. MCP Inspector needs a newer Node 22 than the MCP SDK
- **When:** 2026-10-14 approx. 17:50
- **Task:** Test the local server with `npx @modelcontextprotocol/inspector --cli`.
- **Expected:** Runs on Node 22.14 (the SDK itself only needs Node 18+).
- **Actual:** `EBADENGINE` warnings: Inspector 2.11.0 and its `undici` need Node `>=22.19.0`. It still worked for `tools/list` and `tools/call`.
- **Severity:** low
- **Workaround:** Ignored the warning for now; upgrade to the latest Node 22.x.
- **Suggestion:** Print the required Node version in the Inspector README quick start.

### 5. Bedrock: first call succeeds, then every call fails on a hidden AWS Marketplace subscription
- **When:** 2026-10-15 approx. 18:55–19:05
- **Task:** Use Claude Haiku 4.5 (`in.anthropic.claude-haiku-4-5-20251001-v1:0`, ap-south-1) from a second AWS account through an IAM user limited to `bedrock:InvokeModel` on that inference profile and model.
- **Expected:** If the first Converse call works, later calls with the same credentials work too.
- **Actual:** The first CLI `converse` call returned `"OK"` (458 ms). Every call after that, from both the CLI and the SDK, failed with `AccessDeniedException: ... not authorized to perform the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe) to enable access to this model`. The first invocation apparently triggers an account-level Marketplace subscription, which a least-privilege Bedrock user isn't allowed to complete. The successful first reply hid the problem.
- **Severity:** medium
- **Workaround:** Someone with Marketplace permissions enables the model once for the account (or sends one message in the Bedrock console playground). The least-privilege runtime user stays as it is. Our `weekly_insights` fell back to the guarded template narration, so nothing broke for the user.
- **Suggestion:** Fail the *first* call with the Marketplace error instead of letting it succeed, and list the one-time subscription step next to the IAM examples in the Bedrock model-access docs.
