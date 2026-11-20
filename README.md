# Watch Inventory

Prompt search across Arena Club watches in the warehouse (Metabase 31879) and retrieved items (Metabase 47950), with live totals
(count, EV, cost, EV ÷ cost), group-by totals on any column, a full results table, and CSV export.

## Brand logos
Badges in Totals by brand use `BRAND_LOGOS` (full-colour images) and `BRAND_LOGO_MASKS` (one-colour logos that follow the theme text colour) in public/index.html, keyed by brand name in lower case. Transparent PNGs are kept in `logos/` too. Brands without a logo show their initials.

## Questions
| Tab | Metabase question | Vercel variable |
|---|---|---|
| Warehouse | 48016 | `WAREHOUSE_CARD_ID` (default 48016) |
| Retrieved | 47950 | `RETRIEVED_CARD_ID` (default 47950) |
| All + Image | 31879 (all items) | `ALL_CARD_ID` (default 31879) |

## Finding any watch (shipped/sold too)
Warehouse (31879) and Retrieved (47950) are loaded in full. A reference pasted on the Image tab that isn't in either is looked up
in Metabase directly. The lookup uses question **31879** (Items Search, searched by its Reference # filter) by default — set `LOOKUP_CARD_ID` only to use a different question. This finds shipped/sold watches and watches beyond the 5,000-row load.

## Weight and dimensions
Add these columns to Metabase questions 31879 / 47950 to fill them: `WEIGHT_G` (grams), `HEIGHT_MM` (thickness), `WIDTH_MM`, `LENGTH_MM` (lug to lug). Other common names also work (WEIGHT, THICKNESS_MM, CASE_WIDTH_MM, LUG_TO_LUG_MM…). They show on cards (Size row), in the pop-up, in Columns and are searchable.

## Deploy
1. New Vercel project from this folder (no build step; `public/` is static, `api/` is serverless).
2. Env vars (plus `DATABASE_URL` from Neon, see below): `METABASE_HOST`, `METABASE_API_KEY`, optional `WAREHOUSE_CARD_ID` (default 31879) and `RETRIEVED_CARD_ID` (default 47950).

Use the Warehouse / Retrieved / All switch to pick which watches you're searching. In All, `source:retrieved` and `group:source` work in the prompt. On hand only applies to warehouse watches.
3. Every watch is loaded: the app runs each question without its final `LIMIT` (e.g. `LIMIT 5000`) and gzips the data. If a question's limit is somewhere else in the SQL, remove it in Metabase.

## Vendor and Sold Price (Neon)
On the Retrieved tab only, the "Totals by" table has two typed columns, Vendor and Sold Price, plus Profit (sold − cost) and Sold ÷ cost.
Values are saved per tab + grouping column + row (e.g. Retrieved / brand / Rolex) in Neon and shared with everyone.
Neon stores only those two columns (table `watch_group_fills`) and the list of vendor names (table `watch_vendors`); both are created automatically on first use. Every vendor typed is added to the name list and offered as a pick in every Vendor cell.

Setup: Vercel → Storage → connect a Neon database to the project (this adds `DATABASE_URL`), then redeploy.

## Sign in
Everyone signs in with their **email + password** (sign-in page shows before any data). Default password = first name + 123, lower case (Alan Bailey → `alan123`; `Alan123` also works). Sessions last 14 days (secure HttpOnly cookie). Every API route checks the session; data and edits are refused without one, and turning someone's access off locks them out immediately.
- Admins: add users (email, optional name, optional password), reset passwords, change roles and access.
- Anyone: **Change my password** in Users.
- Vercel: no new variables needed. Optional `SESSION_SECRET` (any long random string) — otherwise one is derived from your existing secrets.

## Users
**Members** (added once each on first run): Beatriz Garay (bgaray@), Brock Kounalis (bkounalis@), Nick Hartley (nhartley@), David Brockway (dbrockway@), Michelle Laddon (mladdon@), Kye Labit (klabit@) — all @arenaclub.com. More can be added in the app by the admin. Admins turn anyone's access **On/Off** in Users; a user whose access is off can't be picked and their edits are refused by the server. No extra Vercel settings are needed — the new columns (`role`, `active`) and table (`watch_meta`) are created automatically.
**Admin:** Alan Bailey (alan@arenaclub.com) is created as admin automatically. Only admins can add or remove users and make others admin (there's always at least one admin). Set `ADMIN_EMAILS` in Vercel to change the default, e.g. `alan@arenaclub.com:Alan Bailey,karl@arenaclub.com:Karl Calma`.
Users are added by **email** (name optional — defaults from the email, e.g. karl.calma@… → Karl Calma). The email is the identity: edits and saved columns are stored under it. `watch_users` gets an `email` column automatically; older name-only users still show and can be given an email.
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
| Watch parts | `rolex steel bracelet white dial`, `leather strap blue dial`, `roman dial`, `gold case`, `ceramic bezel` — a word before bracelet/strap/band, dial, case, bezel, movement searches every column for that part (material, colour, type, style) |
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
