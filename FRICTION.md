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

### 6. Nova Lite and Nova Micro also have zero daily quotas on the new account
- **When:** 2026-10-16 (date of the recorded check; time not noted)
- **Task:** Call Nova Lite and Nova Micro (`apac.amazon.nova-lite-v1:0`, `apac.amazon.nova-micro-v1:0`, ap-south-1) from the account that deploys the stack, to choose the agent model.
- **Expected:** Both inference profiles are listed for the account, so a `converse` call should work.
- **Actual:** The first `converse` call to each fails with `ThrottlingException: Too many tokens per day`. Service Quotas shows every Nova Lite, Nova Micro and Nova 2 Lite quota at 0, and the per-day token quotas are marked not adjustable, so raising them needs an AWS Support case. Same pattern as #3, now for the Nova models.
- **Severity:** high (no Bedrock model could be called from the deploying account, which forced a second account and a cross-account role)
- **Workaround:** Call Nova through a second AWS account where Nova Lite works: an IAM user for local runs, and a role in that account assumed by the deployed Lambdas.
- **Suggestion:** Show a zero applied quota next to "available" in the Bedrock model catalog, and say in the error which quota is 0 and how to raise it.
- **Evidence:** [docs/progress.md](docs/progress.md) (Step 3, "Model access check, 2026-10-16"), [docs/bedrock-access.md](docs/bedrock-access.md) ("Status, 2026-10-16").

### 7. A new account's limit of 10 concurrent Lambda runs throttles a normal dashboard
- **When:** 2026-10-21 (commit bcb712d; time not noted)
- **Task:** Load the web app's Home screen, which reads several tiles at once. Each read uses two Lambdas: the chat function and the MCP function.
- **Expected:** Six small reads at once work at demo scale.
- **Actual:** Tiles showed "Could not load". The account allows 10 concurrent Lambda executions, and CloudWatch recorded throttles (9 + 8).
- **Severity:** medium (visible errors in the demo app until fixed)
- **Workaround:** The web app runs at most 2 reads at a time and retries a throttled read once. `ReservedConcurrency` stays unset, since it can't be reserved out of a limit of 10.
- **Suggestion:** Warn during `sam deploy` (or in the Lambda console) when the account's concurrency limit is far below the default, and link the quota increase request.
- **Evidence:** commit bcb712d message; [docs/progress.md](docs/progress.md) Step 1 ("The account concurrency limit is 10").

### 8. `sam build` needs esbuild on the PATH
- **When:** 2026-10-16 (first deploy; time not noted)
- **Task:** Build the TypeScript Lambdas with `sam build` (esbuild build method), with esbuild installed as a project dev dependency.
- **Expected:** SAM finds the esbuild that the project installed.
- **Actual:** `sam build` needed the project's esbuild on the PATH. The exact error text was not recorded.
- **Severity:** low
- **Workaround:** Put `node_modules/.bin` on the PATH before `sam build` (documented in the README deploy steps).
- **Suggestion:** Look for esbuild in the project's `node_modules/.bin` automatically, or name that fix in the error message.
- **Evidence:** [docs/progress.md](docs/progress.md) Step 1, item 1b; [README.md](README.md) "Deploy to AWS", step 2.

### 9. Nova Lite vision copied example wording from the prompt
- **When:** approx. 2026-10-17 (photo-help work, Step 8)
- **Task:** Ask Nova Lite (vision, through Converse) for structured observations of a crop or cattle photo.
- **Expected:** The observation describes the photo.
- **Actual:** The first vision prompt contained example wording, and Nova Lite copied it into its "observation".
- **Severity:** medium (a wrong observation could steer the guidance shown to a farmer)
- **Workaround:** Removed the examples from the prompt; code assembles the answer from curated notes, and the answer says "not a diagnosis".
- **Suggestion:** Add guidance to the Nova vision prompting docs on example text being repeated as output, with a recommended pattern for structured observations.
- **Evidence:** [docs/progress.md](docs/progress.md) Step 8, "Seen live and fixed".

### 10. Nova Lite tool use: invented values, its own arithmetic, and success claims after a refusal
- **When:** 2026-10-16 (invented policy number and cover: commit c5f84bb; false "has been updated": commit d40829a; invented entry id: phone test in docs/progress.md Step 5) and 2026-10-21 (arithmetic: commit bcb712d)
- **Task:** Let Nova Lite record farm data and answer questions through MCP tools.
- **Expected:** Tool arguments contain only what the farmer said; numbers come from tool results; a refused write is not reported as done.
- **Actual:** In a live run Nova Lite added a policy number and a cover amount the farmer never said; it proposed editing an activity with an id it had invented; after the server refused an edit it replied "has been updated"; and asked for milk value at ₹36.5 a litre it multiplied 18 × 36.5 itself (the number guard replaced the unverified ₹657).
- **Severity:** high (forced a design change: every fact is checked in code)
- **Workaround:** Code-side guards: arguments must appear in the farmer's words, ids must come from the conversation, writes are checked against each tool's JSON Schema, success claims are checked against what was saved, every number in a reply must exist in tool results, and arithmetic moved into a server tool (`get_milk_value`).
- **Suggestion:** Publish tool-use reliability guidance and examples for Nova (not inventing optional arguments, not doing arithmetic that a tool can do, reporting tool errors), and offer a setting that discourages filling optional arguments.
- **Evidence:** commits c5f84bb, d40829a, bcb712d; [docs/progress.md](docs/progress.md) Step 5 ("Second phone finding"); [README.md](README.md) "How the agent stays honest".
