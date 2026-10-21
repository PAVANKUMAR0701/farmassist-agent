# Krishna Farm demo data

`data/krishna-farm/krishna_farm_demo_seed.json` is a **synthetic** demo farm ("Krishna Farm", `farm_id` `KRISHNA-FARM`, as of 2026-10-21). Every name, amount, yield, price, policy reference, egg count and veterinary record in it is illustrative. It is not a real farm's data and not a guide to local prices. Medical entries are placeholders: FarmAssist never presents them as advice, and a veterinarian must decide any medicine, dose and milk withdrawal period.

## Import

```bash
npm run seed-krishna-farm                      # check the file and show what would be written (writes nothing)
npm run seed-krishna-farm -- --apply           # import into farm KRISHNA-FARM in table farmassist-dev
npm run seed-krishna-farm -- --apply --farm demo-farm   # or into another farm
```

- **Idempotent.** Every seed id becomes a stable record id (`src/domain/stable-id.ts`: the record's date plus a hash of `KRISHNA-FARM/<collection>/<seed id>`). Each write is an upsert of that id, so a re-import rewrites the same 488 items and never adds copies. A farm's other records are not touched. A re-import does put back the seed values of any seeded record changed in the app.
- **Safe target.** The script writes only to a table named `*-dev` or `*-demo` (`FARMASSIST_TABLE_NAME`, default `farmassist-dev`; profile `AWS_PROFILE`, default `MyPersonalAWSAccount`). After writing, it reads the farm back and checks that every planned item is stored.
- **Local.** `npx tsx scripts/local-chat-server.ts --krishna` (or the `farmassist-web-krishna` preview) loads the seed into the in-memory server.
- **Removal.** `FARMASSIST_DEMO_FARM_ID=KRISHNA-FARM npm run demo-farm-reset` lists the farm's items, and `-- --apply` deletes them all.

## Validation (`checkKrishnaSeed`)

Errors stop the import: an unknown field in any record (strict schemas, so nothing is dropped silently), a date that is not a real calendar date, a duplicate id, a record of another farm, a calf whose mother is missing or impossible, a reference to an unknown animal or crop, a name that does not match the referenced animal, eggs from a non-chicken, two milk logs for one animal on one day, and any stated total that does not match (amount = quantity × unit price, morning + evening = total, cost parts = total cost, sold + retained = yield, sold × rate = revenue, revenue − cost = net).

`DD-MM-YYYY` and `DD/MM/YYYY` dates are converted to `YYYY-MM-DD`. All dates are farm dates in Asia/Kolkata.

Warnings are reported but imported. The current file has 5:
- COW-007 (Sita) is `milking` with 0 litres a day (and has no milk logs).
- EXP-0068, EXP-0069, EXP-0076 and EXP-0077 (₹13,930 in total) are dated 22–27 October 2026, after the as-of date. They are stored as dated, so totals "up to today" leave them out until those dates come.

## Mapping onto the existing records

Nothing new was added to the table layout: one DynamoDB table, partition `FARM#<farmId>`. Four record kinds were added to the generic record store (see [data-model.md](data-model.md)). Every imported record has `demo: true` and `sourceId` (the seed id, such as `COW-001`).

| Seed collection | Stored as | Field mapping and notes |
|---|---|---|
| `farm`, `metadata` | not stored | Checked only (timezone must be Asia/Kolkata, currency INR). There is no farm-profile record yet. |
| `animals` (32) | `ANIMAL#` | `name_en` (or `name`) → `name`; `name_kn` → `nameKn`; `animal_type` → `type` (`chicken` was added to the animal types); `date_of_birth` → `birthDate`; `mother_animal_id` → `motherId` (the mother's record id) and `motherName`; `lactation_status`, `health_status`, `milk_feeding` kept; `daily_milk_litres` → `usualDailyMillilitres`; `purchase_value_inr` → `purchaseValuePaise`; `notes` kept. |
| `milk_production_daily` (126) | `MILK#` (252) | Two records per log: `morning_litres` and `evening_litres` as sessions `morning`/`evening` in millilitres. `total_litres` is checked, not stored: totals are always added up from the sessions. |
| `expenses` (78) | ledger `EXP#` | `amount_inr` → `amountPaise`; `category` kept. `fertilizer`, `tractor_rent` and `crop_protection` were added to the expense categories. The ledger has no columns for `item`, `quantity`, `unit`, `unit_price_inr`, `vendor` and `payment_mode`, so they are kept word for word in the note, e.g. `Cattle concentrate feed: 10 bag × ₹1,327.00, Sri Lakshmi Cattle Feed, cash (demo EXP-0001)`. The fixed `notes` text ("Synthetic demo expense…") is replaced by that `(demo …)` mark. |
| `crop_records` (6) | `CROP#` | `plot_name` → `field`; `area_acres` → hundredths of an acre; `sowing_date` → `sownDate`; `seed_quantity_kg` → grams (0 = seedlings, not stored); `cultivation_status` → `stage`, and `status` `harvested` or `growing` (`ongoing_harvest` stays open for more pickings); `transplanting_date`, `harvest_date`, `expected_harvest_window` kept; cost columns → `costPaise` and `totalCostPaise`; yield, sold, retained (final, or `…_to_date` with `figuresToDate`) → grams; revenue and net → paise; `sale_rate_inr_per_kg` → paise per kg. |
| `harvest_records` (4) | `HARVEST#` | Linked to its crop record. Quantities → grams; `total_sale_inr` → `salePaise`; `price_per_kg_inr` → `pricePaisePerKg`; `sale_date`, `sold_to`, `quality_grade` kept. The papaya record (180 kg) is one picking. The crop's 1,250 kg "to date" includes pickings without a harvest record, so the crop view shows the larger of the two. |
| `insurance_policies` (14) | `INSURANCE#` | `provider` → `insurer`; `expiry_date` → `endDate`; `premium_inr` → `premiumPaise`; `status` → `demoStatus`; `reminder_days_before_expiry` and `note` kept. No start date or cover amount in the seed. Policy numbers are fictional (`DEMO-KF-…`). |
| `egg_production_daily` (90) | `EGG#` (new) | `chicken_id` → the chicken's record id; `eggs_collected`, `eggs_damaged`, `notes` kept. September 2026 only. |
| `animal_medical_records` (4) | `TREATMENT#` (new) | All fields kept (symptoms, medicine, dose, route, duration, veterinarian, follow-up date, status, withdrawal period, warning). Tools return medicine and dose only as `medicineAsRecorded` / `doseAsRecorded` next to the veterinarian notice, never in answer text. |
| `vaccination_records` (4) | `VACCINATION#` (new) | `date_given` → `dateGiven`; `next_due_date` → `nextDueDate`; `status` → `demoStatus`; the animal's name is added. |
| `feed_inventory` (4) | `FEED#` (new) | `item`, `quantity`, `unit`, `reorder_level`, `last_updated` kept; `status` → `demoStatus`. |
| `demo_queries` (6) | not stored | Each one is a test in `tests/unit/krishna-farm.test.ts`. |

## Statuses are worked out from dates

Stored statuses (`demoStatus`) are kept for reference. Screens and answers use the date-derived status for "today" in Asia/Kolkata:
- **Insurance**: `overdue` once `endDate` has passed, `due_soon` within 30 days, `active` otherwise. On 2026-10-21 this gives 3 overdue, 4 due soon and 7 active, the same as the seed's own statuses. On a later date the result changes (a test checks 2026-11-05).
- **Vaccinations**: `overdue`, `due_soon` (within 30 days) or `upcoming`, from `nextDueDate`.
- **Feed**: reorder when the quantity is at or below the reorder level.
- **Vet follow-ups**: treatments that are not `completed`, with a follow-up date within the next 30 days or already passed.

## Read tools and screens

| Question | Tool | Screen |
|---|---|---|
| Animal counts and profiles | `list_animals`, `get_animal_profile` | Farm → Herd (tap an animal) |
| Feed stock and reorder alerts | `get_feed_stock` | Farm → Feed stock |
| Monthly expenses by category, 6-month total | `get_expense_summary` with `period: last_6_months`, `groupBy: month` | Expenses → Last 6 months by month |
| Crop progress, harvest, sales and retained stock | `list_crops` | Farm → Crops |
| Insurance overdue / due soon, days overdue, premium | `list_insurance` | Farm → Insurance to renew |
| Eggs per chicken per day and per day | `get_egg_summary` | Farm → Eggs by chicken |
| Milk per animal per day | `get_milk_summary` with `groupBy: animal_day` | Farm → Milk by animal |
| Treatments, follow-ups, overdue vaccinations | `get_health_records` | Farm → Animal health |

Records imported as demo data show a "Demo data" notice on the Farm screen and in tool results. Health records always carry the veterinarian notice.

## Demo query results (2026-10-21)

| Query | Result |
|---|---|
| How many animals are on Krishna Farm? | 32: 20 cows, 4 buffaloes, 5 calves, 3 chickens |
| Which animal insurance is overdue? | Lakshmi (ended 2026-10-03, 18 days, ₹2,200), Gangamma (2026-10-10, 11 days, ₹1,950), Durga (2026-10-15, 6 days, ₹1,800) |
| Farm expenses for the last six months? | ₹3,53,158.00 in 74 entries from 2026-05-01 to 2026-10-21, by month and category (the 4 later-dated entries are left out) |
| How much paddy, ragi and maize did we harvest? | Paddy 4,200 kg, ragi 1,050 kg, maize 5,100 kg |
| How many eggs yesterday? | None on 2026-10-20: egg records cover September 2026 only (latest 2026-09-30) |
| Which animal needs vaccination or follow-up? | Lakshmi FMD vaccination 11 days overdue; Gangamma FMD due 2026-10-22; vet follow-ups for Chamundeshwari (2026-10-22) and Gange (2026-10-23) |

Names: "Kaveri" is both a buffalo (BUF-002) and a hen (CHK-002). A question by that name alone is answered by asking which one, never by guessing.
