# Watch Inventory

Prompt search across Arena Club watches in the warehouse (Metabase 31879) and retrieved items (Metabase 47950), with live totals
(count, EV, cost, EV ÷ cost), group-by totals on any column, a full results table, and CSV export.

## Brand logos
Badges in Totals by brand use `BRAND_LOGOS` (full-colour images) and `BRAND_LOGO_MASKS` (one-colour logos that follow the theme text colour) in public/index.html, keyed by brand name in lower case. Transparent PNGs are kept in `logos/` too. Brands without a logo show their initials.

## Weight and dimensions
Add these columns to Metabase questions 31879 / 47950 to fill them: `WEIGHT_G` (grams), `HEIGHT_MM` (thickness), `WIDTH_MM`, `LENGTH_MM` (lug to lug). Other common names also work (WEIGHT, THICKNESS_MM, CASE_WIDTH_MM, LUG_TO_LUG_MM…). They show on cards (Size row), in the pop-up, in Columns and are searchable.

## Deploy
1. New Vercel project from this folder (no build step; `public/` is static, `api/` is serverless).
2. Env vars (plus `DATABASE_URL` from Neon, see below): `METABASE_HOST`, `METABASE_API_KEY`, optional `WAREHOUSE_CARD_ID` (default 31879) and `RETRIEVED_CARD_ID` (default 47950).

Use the Warehouse / Retrieved / All switch to pick which watches you're searching. In All, `source:retrieved` and `group:source` work in the prompt. On hand only applies to warehouse watches.
3. If either question has a `LIMIT` in its SQL, remove it so totals include every watch.

## Vendor and Sold Price (Neon)
On the Retrieved tab only, the "Totals by" table has two typed columns, Vendor and Sold Price, plus Profit (sold − cost) and Sold ÷ cost.
Values are saved per tab + grouping column + row (e.g. Retrieved / brand / Rolex) in Neon and shared with everyone.
Neon stores only those two columns (table `watch_group_fills`) and the list of vendor names (table `watch_vendors`); both are created automatically on first use. Every vendor typed is added to the name list and offered as a pick in every Vendor cell.

Setup: Vercel → Storage → connect a Neon database to the project (this adds `DATABASE_URL`), then redeploy.

## Users
"Editing as" (next to Totals by) opens the user list. Add people, pick who you are (remembered per browser);
every Vendor / Sold price edit is saved with that name (hover a cell to see who last edited it). Users live in Neon (`watch_users`).
Columns (List view) opens a pop-up to pick table columns; Save stores them for the picked user in Neon (`watch_user_prefs`) and they load whenever that user is picked.

## Image tab
Paste references (one per line, commas or spaces; "ref" words are ignored). Numbers are matched as references first; an 8AC or order number still works and shows up as its reference. Searches warehouse + retrieved.
- **Summary** (default): one row per ref, one column per dial variant found in the system. Each cell is just ✓ YES (at least one watch of that ref + dial has a photo — one is enough) or ✗ NO (needs a photo). Totals are counted in variants. Click a cell to open those watches in the pop-up.
- **List**: every matching watch with ✓ YES / ✗ NO for image, plus not-found rows. "No image only" filter and CSV export.
- **Full**: one row per ref, with a card per dial colour (image, count, how many have images). An 8AC number shows that one watch.

## Prompt syntax
| What | Examples |
|---|---|
| Any word, any column | `rolex`, `all rolexes`, `seiko blue` (plurals work) |
| AC / 8AC number | `4220749`, `ac 4220749`, `8ac number 4220749` |
| Order number | `20575379`, `order 20575379`, `order number 20575379` |
| Reference | `ref 14000`, `reference number 14000`, `14000` |
| PO | `po 4645` |
| Several at once | `ac 4220749, 3302372`, `4220749 3302372 20575379` (paste a list), `ref 14000, 16610` |
| Either word | `rolex omega black dial` (Rolex or Omega, black dial), `black blue dial`, `rolex or omega` — words that are values of the same column (brand, dial, status…) mean any of them |
| Dollar range (EV) | `$400-$5000`, `$400 - $5,000`, `$3k-$6k`, `between $400 and $5000`, `under $1,000`, `over $8k`, `$5k+` |
| Any column | `condition excellent`, `case_material:gold`, `bin:w-12`, `tag vookum`, `blue dial` |
| Any column by name | `case size 40`, `bracelet color brown`, `item status listed`, `po number 4645`, `papers original` |
| Weight / height / width / length | `weight 120-160`, `weight >150`, `height <11`, `width 40`, `length 45-50` (mm and grams) |
| Exact | `brand=Rolex` |
| Numbers | `ev>5000`, `cost<=1200`, `size:36-40` |
| Exclude | `-seiko`, `-status:listed` |
| Totals by | `group:brand`, `group:dial` |
| Sort | `sort:ev`, `sort:cost:asc` |

A bare number that is exactly an AC, order, ref or PO number matches only that ID; several bare IDs together match any of them.

`On hand only` hides sold, shipped, delivered, archived, cancelled, returned, not accepted and rejected.
Any `status:` filter in the prompt overrides it.

If the question has its own filters for ref, AC, PO, order or model, the app finds them automatically and uses them, so those searches are never cut off by a LIMIT. Without them, everything is filtered in the app.
