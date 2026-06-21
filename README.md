# Wander Doll · Product Tools

Internal web app for the Wander Doll product/merch team. It turns messy purchase-order
spreadsheets into ShipHero uploads, syncs POs back from ShipHero into a local cache,
and gives merch a dashboard + searchable PO history with live editing — all without
hammering ShipHero's credit-metered API.

> **Safety model:** the app **builds** every ShipHero *write* (push a PO, edit a PO),
> but a write only ever fires when a **user clicks Save/Confirm**. Reads (sync,
> detail, SKU checks) are automatic. Mind the 4004-credit-per-operation cap.

## Stack

- **Next.js 16** (App Router, Turbopack) — one app, UI + API routes.
- **TypeScript** everywhere; the converter is a pure, unit-tested function.
- **SQLite + Drizzle** — single `data.db` file (`DATABASE_PATH`). Self-migrates +
  seeds on boot. Swap to Postgres later by changing `src/db/index.ts` only.
- **Tailwind v4** — dense, Excel-like "Console" UI, light theme, Poppins type.
- Parsing: `exceljs` (.xlsx) + `papaparse` (.csv); CSV out via `papaparse`.

## What it does

### Purchase Orders → ShipHero (`/purchase-orders`)
Upload a PO sheet (.xlsx/.csv) → columns **auto-map** (fuzzy, handles extra/renamed
columns) → supplier **aliases resolve** to exact ShipHero vendor names → **status
matching** against your ShipHero statuses → editable preview grid (sell-ahead toggle,
per-PO status) → **Download ShipHero CSV** *or* **Push to ShipHero** (confirm modal
with read-only pre-flight: warehouse auto-detect, duplicate-PO check, vendor/status
check, **SKU-existence** check).

### PO History (`/history`)
**Sync** pulls POs (headers + line items) from ShipHero into the local cache; the page
then reads the **DB** (instant, zero credits). Excel-style **column filters** (funnel
icons + active-filter bar), text search, **CSV export** of the current view, and a
range dropdown. Click a PO → **detail modal**: read-only by default, **Edit** reveals
status / expected-date / per-line qty+price → confirm-gated **Save to ShipHero**
(re-syncs that PO). Per-size **receiving bars** show what's landed.

### Dashboard (`/dashboard`, landing page)
KPIs (Open POs, Units on order, Value on order, Landing ≤14 days, Overdue), a
**Receiving** panel, status/vendor breakdowns, **Upcoming deliveries**, order-value-
by-month, and an **Overdue** table. All from the cache.

### Products → Shopify (`/products`)
A separate **file-in → file-out** tool (does NOT touch Shopify directly): upload a
**Style Arcade** `.xlsx` export → columns auto-map (with a **Columns** remap panel,
required fields flagged) → size ranges expand to one row per variant → builds the
**Hextom** multi-variant CSV (Title + metafields on the first row of each product,
blank on the size rows beneath — that's how Hextom groups variants). Cost logic:
Summa → Converted £, others → $. **Scenario A** (factory_cost_price) / **B**
(+ landed_cost_price) toggle, editable **season suffix** (`_NEW`). Preview shows
product/variant counts, a **column-fill %** panel, and warnings (dup codes /
unrecognised size ranges). Download A, B, or both. The pure converter
(`src/lib/styleArcade/convert.ts`) is a faithful port of `convert_style_arcade.py`.

### Vendors (`/vendors`)
Alias → ShipHero-vendor mappings (dropdown, never typed). **Sync from ShipHero** pulls
canonical vendor names byte-for-byte (kills the name-mismatch class of upload errors).

### Size Map (`/sizes`)
Editable size **label → SKU code** table (XXS=98 … plus brackets XS-S etc), DB-backed.
**Both tools read it live** (threaded server-side): the Products converter *generates* SKUs
from it (so adding `4XL=87` changes output with no code change), and the PO side uses it to
*derive size labels* for display + dedupe product names. All size helpers default to the
hardcoded map (tests), and the app passes the DB map in.

## Develop

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # vitest — 33 tests incl. golden + end-to-end vs real files
npm run build        # production build (server + client compiled together)
```

The DB self-initialises on boot (migrations + seeds vendors / statuses / size codes).
To reseed: `npm run db:seed`. To change schema: edit `src/db/schema.ts` → `npm run db:generate`.

### Connect ShipHero
Put a refresh token in `product-tool/.env.local` (gitignored):
```
SHIPHERO_REFRESH_TOKEN=...     # required; mints access tokens automatically
SHIPHERO_ACCESS_TOKEN=         # optional; use it immediately until it expires (~28d)
# SHIPHERO_WAREHOUSE_ID=       # NOT needed — warehouse is auto-detected
```
Then **Sync** on PO History / Dashboard, or **Sync from ShipHero** on Vendors.

## Tests = proof against real data (42 tests)
- `shiphero/convert.test.ts` — PO spec acceptance (12 POs / 68 lines / 2,400 units).
- `shiphero/golden.test.ts` — reproduces a **real successful ShipHero upload** byte-for-byte.
- `shiphero/e2e.test.ts` — real raw merch input → full parse→map→convert → that real upload.
- `shiphero/push.test.ts` — status matching, push-input builder, size derivation, SKU-suffix strip.
- `styleArcade/convert.test.ts` — Style Arcade acceptance (Summa £ vs $, SKUs -98..-93, `_NEW`,
  block SKU, blank metafields on size rows, Scenario B landed cost, size-range expansion).

## Project layout (high level)

```
src/
  app/            pages (dashboard, purchase-orders, products, history, vendors, sizes)
                  + api/{po, vendors, products, sizes}
  components/     sidebar, po-converter (+PushModal), po-history (+PoDetailModal), dashboard,
                  vendor-manager, product-converter, size-manager, column-filter
  lib/shiphero/   convert (pure) · parse · client (GraphQL auth/throttle) · po-pull ·
                  push-builder/push-api · po-edit · sku-check · warehouse · vendor-sync · types/fields
  lib/styleArcade/ convert (pure port) · parse  — Style Arcade → Shopify CSV
  lib/            sizes.ts (SizeMap, expandSizes, stripSizeSuffix) · size-codes.ts · vendors.ts · po-cache.ts
  db/             schema, drizzle client (self-init), seed (vendors/aliases/statuses/size codes)
samples/          real raw input + real working ShipHero upload (test oracles)
docs/             SHIPHERO_API_REFERENCE.md (verified GraphQL shapes for editing/push/webhook)
```

## ShipHero integration — key facts

- **Pagination** goes on the inner `data` connection: `purchase_orders(...) { data(first:N, after:"…") { edges } }` — and cap `line_items(first:N)`. Unbounded blows the 4004-credit cap (a full `purchase_orders`+`line_items` cost 10,101 and was rejected).
- Single-PO read: `purchase_order(id: "<legacy_id>")` (numeric). Mutations use `po_id` = the **base64 global id** (cached as `globalId`).
- Edits: status via `purchase_order_set_fulfillment_status`; date/notes/line qty+cost via `purchase_order_update` (lines matched **by SKU**; don't add/remove SKUs; `quantity_received` is ShipHero's and read-only).
- After adding a new GraphQL field, **Sync** to repopulate the cache.
- Statuses are free-text (no enum / no list API) — the valid set is seeded in `po_statuses` from the ShipHero admin screen.

## Deploy (DigitalOcean droplet)

```bash
docker compose up -d --build      # serves :3000, SQLite on the `po-data` volume
```
Put Nginx/Caddy in front for HTTPS at **wanderdoll.truepathgroup.co.uk**.

## Roadmap / not built yet
- **Receiving webhook** (real-time `quantity_received`) — PAUSED; needs the public deploy URL (can't register against localhost). Sync covers received qty meanwhile.
- **Login / auth gate** (internal only) before go-live.
- **Deploy** to wanderdoll.truepathgroup.co.uk.
- Build-a-PO-from-scratch, duplicate PO, notes/comments.

Open items to confirm with the team (Products): Scenario **A vs B** (Will's cost-swap sign-off),
the `factory_cost_price` rename ambiguity (spec §3.2), and the optional **Handle** column (§9, not built).
Verify the Products converter against a **real Style Arcade export** (column-name matching vs the live layout).
