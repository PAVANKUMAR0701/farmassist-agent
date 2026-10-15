# Verified-number guard

`weekly_insights` uses Amazon Bedrock to explain a week of farm records in plain language. A language model can make up a number that sounds plausible, and telling it not to isn't enough. So every Bedrock draft goes through a deterministic check before anyone sees it.

## Flow

1. **Read** the week's expenses, the previous week's expenses and the week's activities from DynamoDB.
2. **Calculate** every figure in code (`src/domain/weekly-facts.ts`): totals in integer paise, category shares, the change from the previous 7 days, and activity counts.
3. **Narrate:** Bedrock (Converse API) receives only that facts object, never raw entries or notes. The system prompt tells it to copy the money display strings exactly and not do any arithmetic (`src/services/insight-narrator.ts`).
4. **Check:** `checkNumbers()` (`src/domain/number-guard.ts`) pulls out every number in the draft and compares it with the facts.
5. **Decide** (`src/tools/weekly-insights.ts`):
   - All numbers supported → show the Bedrock text (`guard.status: "passed"`).
   - Any unsupported number → retry once, telling the model which numbers were wrong.
   - Still failing → **replace** it with template text built only from the facts (`"replaced"`). The rejected numbers are returned in `guard.rejectedNumbers`, so the demo can show the guard at work.
   - Bedrock errors, throttling or no configured model → template text (`"bedrock_unavailable"` / `"bedrock_not_configured"`).
   - Fewer than 2 expenses in the week → no Bedrock call at all (`"not_needed"`).

Template narration passes the same guard (tested), so no unverified number is ever shown, whichever path runs.

## What is allowed

The guard reads allowed values from the facts by field name:

| Facts field | Allowed in text as |
|---|---|
| `*Paise` | Money: `₹2,650.25`, `Rs. 2650.25`, `2,650.25 rupees`, or a bare number. Rounding to whole rupees (`₹2,650`) is accepted. |
| `*Percent` | Only with `%`, `percent` or `per cent` |
| `*Count` | Bare numbers (`3 expenses`) and the words two to twelve |
| ISO date strings | Dates written as `YYYY-MM-DD` |

Units are checked. A count can't appear as a percentage (`3%`), and a percentage can't appear as money (`₹75`).

## Known limitations

- **Dates in other formats** (`14 October`, `Monday the 12th`) are rejected, because `14` and `12` look like unsupported numbers. That's safe but strict: the prompt tells the model not to mention dates, and the UI shows the period separately.
- **Number words:** only *two* to *twelve* are recognised and checked. *One* isn't checked, because it's usually a pronoun. Magnitude words (*hundred, thousand, lakh, crore, million*) are always rejected. Other words (*half, double, first, a dozen*) aren't detected.
- **Rounding:** only rounding money to whole rupees is accepted. "About ₹3,500" for ₹3,550.25 is rejected.
- **Coincidental matches:** the guard checks numbers, not meaning. A real number attached to the wrong label (for example, the medicine total described as the feed total) would pass. The low temperature and the instruction to copy display strings reduce this risk, but the guard doesn't remove it.
- **Percentages are whole numbers.** Category shares are rounded separately, so they may not add up to exactly 100.

## Tests

- `tests/unit/number-guard.test.ts`: facts are hand-calculated; the guard rejects invented totals, invented percentages, wrong units, model-made projections, unknown dates and magnitude words; template narration passes.
- `tests/unit/weekly-insights.test.ts`: the full tool with a scripted narrator: pass-through, retry with feedback, replacement after repeated failures, Bedrock failure, no model configured, too little data.
- `tests/unit/insight-narrator.test.ts`: the shape of the Converse request (model, system prompt, temperature, facts in the message) using a mocked Bedrock client.

No unit test calls paid Bedrock.
