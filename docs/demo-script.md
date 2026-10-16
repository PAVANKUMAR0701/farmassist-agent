# Three-minute demo

Recorded on a phone (Chrome, Android) with the deployed web app, signed in as the demo farmer. Speak each line; every change is read back before it is saved.

**Before recording:** clean the demo farm of test data (see progress.md), make sure "Read replies aloud" is on, and start a new chat.

| Time | Do / say | What to show |
|---|---|---|
| 0:00–0:15 | One sentence on the problem: small farmers keep accounts in their heads or on paper; FarmAssist keeps them by voice, and its numbers are calculated, never guessed. | The Today screen. |
| 0:15–0:40 | 🎤 "I have three cows, Lakshmi, Maya and Geeta. Lakshmi is HF." → read-back → "haan" | **One read-back for all three animals.** Then the Farm tab with the herd. |
| 0:40–1:00 | 🎤 "Lakshmi gave 8 litres this morning and 7 in the evening, Maya gave 6." → "yes" | The read-back, then "Milk today" on Today (21 L, added up by the server). |
| 1:00–1:20 | 🎤 "Spent 2500 on cattle feed." → "yes". Then 🎤 "No, it was 2400." → "yes" | The correction ("₹2,500.00 → ₹2,400.00") and the audit trail it creates. |
| 1:20–1:45 | 🎤 "I planted paddy in the north field in June, 2 acres, 50 kg seed." Later: "Harvested 30 quintal, final harvest." | The Farm tab: 15 quintal per acre, 60× the seed, worked out by code. |
| 1:45–2:10 | 📷 A photo of a cow with skin lumps, typing "lumps on her skin". | The red, urgent answer: what is visible, "can look like lumpy skin disease", "must be reported, call the veterinarian today", "not a diagnosis". |
| 2:10–2:35 | Type: "how was my week?" | Weekly insight: every number checked by the number guard and the meaning guard. |
| 2:35–2:55 | The architecture diagram (README): MCP server on Lambda, agent as an MCP client, Nova Lite on Bedrock, guards in code. | "If Bedrock is down, basic mode still records and answers." |
| 2:55–3:00 | Close: "Talk to your farm ledger — every number verified, never guessed." | — |

**Say honestly in the video or the submission text:** Alexa+ developer tools are partner-only, so FarmAssist is shown through its own web client, not on an Alexa device. Photo help gives general guidance and is not a validated diagnostic tool.
