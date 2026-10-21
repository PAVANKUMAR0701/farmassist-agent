# Demo script (under three minutes)

Recorded with the deployed web app, signed in as the Krishna Farm demo user (farm `KRISHNA-FARM`, synthetic data, see [demo-data.md](demo-data.md)). The farm is used as it is: nothing is wiped or reset, and no animal is registered again (Lakshmi and the other animals already exist, and a second active animal with the same name is refused).

**Say this in the video and in the submission text:** the voice panel is an **Alexa-style simulator in the FarmAssist web app**. It is not connected to Alexa+ or to an Amazon device; the Alexa+ developer tools are partner-only ([FRICTION #1](../FRICTION.md)). What is real is the self-hosted MCP server (MCP 2025-11-25, Streamable HTTP) that the app's agent calls, running on AWS. Krishna Farm is demo data, and health records are not veterinary advice.

## Before recording

- Sign in as the demo user. Turn on "Voice replies on". Start a new chat.
- Numbers depend on the day: the seed is dated up to 2026-10-21 (milk logs end that day, egg records cover September 2026), and insurance and vaccination days are counted from today. Read the numbers off the screen; don't script them.
- Recording the spoken expense (1:30) adds one real expense to Krishna Farm. Re-running the seed import does not remove it.
- Rehearse the whole run once on the device and browser you record with, and time it. Speech recognition and voices depend on the browser, and spoken read-backs and replies take several seconds each; trim pauses in editing.

## Timeline (about 2:48, leaving 12 s of slack)

Narration is one or two short sentences per row (about 150 words a minute). "Verified" means it was seen working with the Krishna data, as listed under Evidence.

| Time | Do / say | What to show | Status |
|---|---|---|---|
| 0:00–0:15 | One sentence on the problem: small farmers keep their records in their heads or on paper; FarmAssist keeps them by voice, and its numbers are calculated by the server, never guessed. | Home: the five tiles (spent today, milk today, animals, growing crops, due soon). | Verified |
| 0:15–0:40 | Open **Farm**. Point at the herd count by kind. Tap **Kamala** (a calf). | The profile: Kannada name, mother Lakshmi, age, "Demo data". Close it. The milk table: litres per animal per day for the last 7 days. | Verified |
| 0:40–1:05 | Scroll the right-hand column. | **Insurance to renew**: overdue and due-soon policies with days overdue and premium. **Animal health**: vet follow-ups and vaccinations due, and the veterinarian notice. **Feed stock**: items to reorder. | Verified |
| 1:05–1:20 | Scroll the left-hand column. | **Crops**: harvested quantity, sold, kept and sales for paddy, ragi and maize; papaya "so far"; banana and tomato growing. **Eggs by chicken** per day. | Verified |
| 1:20–1:30 | Open **Expenses**, scroll to **Last 6 months by month**. | The six-month total and each month by category, all added up by the server. | Verified |
| 1:30–2:00 | Tap the mic and say: "Spent 1200 on diesel." Hear the read-back, say "yes". | The read-back before saving, then the reply and the MCP tool calls listed under it (`record_expense`, category fuel). | **Not yet verified on the deployed Krishna Farm** (verified in memory only). Confirm in rehearsal; if it fails, drop this row. |
| 2:00–2:15 | Open **Home**. | The **Last 7 days** card: the weekly insight and "Every number here is checked against your saved records." | Verified |
| 2:15–2:40 | The architecture diagram from the README. | Web app and agent (MCP client) on AWS Lambda, the MCP server on Lambda with DynamoDB, Cognito sign-in, Nova Lite on Amazon Bedrock, guards in code. "If Bedrock is down, basic mode still records and answers." Repeat: the voice panel is a simulation, not Alexa+. | Diagram only |
| 2:40–2:48 | Close: "Talk to your farm ledger — every number verified, never guessed." | — | — |

## Evidence

- **Home tiles, Farm screen, animal profile (Kamala), Expenses by month, Home's Last 7 days card:** seen in the local preview with the same seed and code on 2026-10-21, at 1672 × 940, 1366 × 768 (Home scrolls about 100 px there) and phone width. The deployed app serves the same build (checked by its CSS and script). Not yet checked on a real phone or on the deployed site while signed in.
- **Weekly insight on the deployed stack:** on 2026-10-21 the deployed `weekly_insights` for Krishna Farm returned Nova Lite wording with the number guard passing (the local preview showed the template wording, because it ran without Bedrock).
- **Spoken expense:** `npm run farm-scenario` on Nova Lite (voice mode, read-back then "yes") stores "diesel expense ₹1,200 as fuel" correctly (10/10 checks, 2026-10-21, in memory). Spoken expenses were also used in earlier real Edge sessions on the deployed app (commit 196bbe5). It has not been tried on the deployed Krishna Farm.
- **Timing:** estimated from the row lengths, not measured. Time the rehearsal.

## Not in the timed script (unverified through chat)

These tools pass their tests on the Krishna data (`tests/unit/krishna-farm.test.ts`), but asking them through the chat agent has not been tried yet: "Which animal insurance is overdue?", "Which animal needs vaccination or follow-up?", "How much paddy, ragi and maize did we harvest?", "How was my week?" asked in chat. Rehearse them first and add one only if it works and the timing allows. Photo help (📷) was checked earlier with generated pictures only; it gives general guidance and is not a validated diagnosis.
