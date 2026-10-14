# Data model

One DynamoDB table, on-demand capacity. Every item for a farm shares one partition key, so a farm's data is never mixed with another farm's, and every query is scoped to one farm.

| Item | PK | SK | Main attributes |
|---|---|---|---|
| Expense | `FARM#<farmId>` | `EXP#<YYYY-MM-DD>#<ULID>` | `entryId`, `date`, `category`, `amountPaise`, `note`, `createdAt`, `updatedAt`, `version` |
| Activity | `FARM#<farmId>` | `ACT#<YYYY-MM-DD>#<ULID>` | `entryId`, `date`, `activityType`, `animalOrField`, `note`, `createdAt`, `updatedAt`, `version` |
| Idempotency marker | `FARM#<farmId>` | `IDEM#<clientRequestId>` | `entryId`, `entrySK`, `fingerprint`, `expiresAt` (TTL, 7 days) |

Correction audit records will be added with `correct_entry`.

Entry ids are `exp_<YYYYMMDD>_<ULID>` for expenses and `act_<YYYYMMDD>_<ULID>` for activities.

## Why this shape

- **Date-first sort key.** "This month", "last week" and "today" are all a single `Query` with `SK BETWEEN EXP#<from># AND EXP#<to>#~`. No scans.
- **ULID after the date.** ULIDs sort by creation time, so entries on the same day come back in recording order. That is what makes "the last one I recorded" well-defined for corrections.
- **Public entry id `exp_<YYYYMMDD>_<ULID>`.** The id contains everything needed to rebuild the sort key, so a correction can `GetItem` directly without searching.
- **No category index (GSI) yet.** Category questions are always asked for a date range, so we query the range and filter by category. A small farm has at most a few thousand entries a year, so this stays cheap. If needed, a GSI on `FARM#<id>#CAT#<category>` can be added without changing existing items.

## Money

Amounts are stored as **integer paise** (`amountPaise`). Rupees appear only in tool input (`amountRupees`) and in display strings (`amountDisplay`, formatted by code with Indian digit grouping). Totals are integer sums in code (`src/domain/expense-summary.ts`), never computed by the language model.

## Dates

`date` is the farm-local calendar date in **Asia/Kolkata**. "Today", "this week" (Monday start), "this month" and "last month" are resolved on the server (`src/shared/time.ts`), never by the client or the model.

## Idempotency

With a `clientRequestId`, the entry (expense or activity) and its `IDEM#` marker are written in **one `TransactWriteItems`**, both conditional on `attribute_not_exists(PK)`. A retry finds the marker:
- **same fingerprint** (same kind and same arguments as sent) → returns the original entry with `duplicate: true`, writes nothing;
- **different fingerprint** → rejected, because the id was reused for a different request (including an expense id reused for an activity).

## Tenant isolation

The `farmId` comes **only** from the authenticated bearer token (`src/auth/bearer.ts`), never from tool arguments. Pagination cursors include the farm id and query filters and are rejected if replayed by another farm or with different filters.
