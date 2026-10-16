# Agent model evaluation

Which Bedrock model should drive the FarmAssist agent? Measured with `npm run agent-eval` against the deployed backend (stack `farmassist-dev`), on 2026-10-16. Models were called through the Bedrock account (231427841372, ap-south-1, `apac.` inference profiles).

## Method

There are 11 cases, each run in a fresh conversation. Only the last turn of each case is scored. A case passes only when all of these hold:
- The model chose the expected tool with the expected arguments (amount, category, date, the real `entryId` for corrections, and the right range). An ambiguous message ("I spent 700") must not cause any write.
- The model did not fail. A failure would fall back to the parser and count as a fail.
- The reply leaks no reasoning text and no entry ids.
- Every number in the reply came from the tool results or the farmer's message (otherwise the agent's number check replaces it).
- The reply contains no markdown, which a voice reply can't use.

Cases: record an expense; correct it ("no, it was 2400"); "Diesel 1200"; a vet payment, which should be medicine; vaccinating a named cow; a Hinglish expense ("300 rupaye ka diesel liya"); "I spent 700" with no category; feed spending this month; one day's spending; listing a month; weekly insights.

Writes are dated January 2025 so they stay out of "today" and "this month" views.

## Results (3 runs per model, 33 scored turns each)

| Model | Passed | Median / max latency per turn | Verdict |
|---|---|---|---|
| Nova Lite (`apac.amazon.nova-lite-v1:0`) | **32/33** | 1.5 s / 2.6 s | **Use for the agent.** |
| Nova Micro (`apac.amazon.nova-micro-v1:0`) | 8/33 | 1.7 s / 2.5 s | Not suitable for the agent. |

Nova Lite's tool choices and arguments were correct in every write case across all runs, including Hinglish and the vet → medicine mapping. Its one miss: while listing a month it numbered the entries. The number check blocked that reply and showed the server's line instead, so the farmer saw nothing wrong.

Nova Micro chose the right tools for writes, but it put markdown lists in almost every reply despite an explicit instruction. Even with today's date in the system prompt, it passed `weekEnding` = yesterday for "how was my week?" in all 3 runs. In the first round, before the date was in the prompt, it asked for a week in **2023**. It may still suit simple text-only jobs where code checks the output, such as weekly-insight wording behind the number guard. That is to be measured in Step 6.

## What the evaluation changed in the agent

The first round scored Nova Lite at 10/11, then 8/11, and Nova Micro at 8/11, then 10/11, so one run per model was too noisy. Each issue below was traced to a cause in the agent:

| Problem seen | Cause | Fix |
|---|---|---|
| Nova shows `<thinking>…</thinking>` text in replies | Nova writes its reasoning into the text when using tools | `cleanModelText` strips it before the farmer sees the reply |
| A model guessed the year (2023) | It wasn't told today's date | The system prompt states today's date in India time |
| A correction used a garbled entry id (the server refused it, so nothing was corrupted) | History kept only text with an `[entryId: …]` note | History keeps the real tool-use and tool-result blocks |
| An `[entryId: …]` note was copied into a reply | Same note in history | Removed from replies; the prompt says never to mention ids |
| `health_check` was called for nothing (+3 s) | It was offered to the model | Hidden from the model |
| "I spent 700" was recorded as `other` | No rule against defaulting | Prompt: use `other` only when the farmer says what it was |
| Totals invented from `list_expenses` rows (₹29,600 etc.), caught by the number check | The model added up a partial list | The prompt sends "how much" questions to the summary tools; lists aren't totalled |
| After a blocked reply with no tool calls, the farmer got the help text | The fallback text was generic | The deterministic parser answers instead (e.g. "What was the ₹700 for?") |

## Live end-to-end check

`npm run agent` with Nova Lite: "paid 1750 to the labourer on 2025-01-23" followed by "no, it was 1500". DynamoDB then held the labour expense at 150000 paise, version 2, with a `CORR#` audit item of 175000 → 150000.

## Rerun

```bash
FARMASSIST_MCP_URL=<McpEndpoint> BEDROCK_AWS_PROFILE=M80PocBedrockKeys npm run agent-eval -- --runs=3 apac.amazon.nova-lite-v1:0 apac.amazon.nova-micro-v1:0
```
