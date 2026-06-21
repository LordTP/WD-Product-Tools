# ShipHero GraphQL API — reference for Phases 2–3

> Researched 2026-06-20 from official ShipHero developer docs + community. This is
> the integration reference for wiring direct ShipHero access (vendor sync, PO
> push, status updates, receiving webhook). **Verify ❓-flagged items against the
> live schema** (introspect `https://public-api.shiphero.com/graphql` with a Bearer
> token, or browse `https://developer.shiphero.com/schema/`) before relying on them.

Endpoint: `https://public-api.shiphero.com/graphql` (GraphQL only). Auth refresh:
`https://public-api.shiphero.com/auth/refresh`. IDs are base64 global IDs; most
objects also expose numeric `legacy_id`. Money/weights are **Strings**, quantities
are **Int**.

## 1. Auth ✅
`POST /auth/refresh` with `{ "refresh_token": "..." }` → `{ access_token, expires_in, token_type }`.
Access token lasts **28 days**; refresh token is long-lived (treat like a password).
GraphQL calls send `Authorization: Bearer <access_token>`.

## 2. Vendors — read ✅
`vendors(first: 50)` returns a cursor connection. Per-vendor fields: `id`,
`legacy_id`, `name`, `email`, `account_number`, `account_id`, `currency`,
`default_po_note`, `partner_vendor_id`, `address { … }`. Server-side name
filtering is unreliable — fetch and filter client-side. ⚠️ Confirm exact
connection nesting (`data { edges { node } }`).

→ **Use this for byte-for-byte vendor sync**: pull `name` per vendor, store as the
canonical ShipHero name behind our short alias.

## 3. Vendors — create ⚠️/❓
Likely **`vendor_create`** (NOT `vendor_add`), input `{ name, email, account_number,
address {…}, currency, default_po_note }`. **Confirm name/wrapper/required fields
against live schema before building "add vendor → push to ShipHero".**

## 4. Purchase orders — mutations
`purchase_order_create` ✅ — required: `po_date, po_number, subtotal, tax,
shipping_price, total_price, discount, warehouse_id, vendor_id, fulfillment_status,
line_items[]`. Line item: `{ sku, quantity:Int, price:String, vendor_id,
quantity_received:Int, quantity_rejected:Int, product_name, fulfillment_status,
sell_ahead:Int, expected_weight_in_lbs:String }`. `warehouse_id` is **required**.

`purchase_order_update` ⚠️ — keyed by `po_id`, line items matched by **`sku`**.
**GOTCHA: `quantity_received` in the update mutation is ACCUMULATIVE (added to
existing), not absolute.** Adding/removing whole line items is not cleanly
documented — ❓ confirm; safest is cancel+recreate when the SKU set changes.

Close/cancel: **`purchase_order_close`** ✅ (`{ po_id }`, → Closed, no inventory
effect). `purchase_order_cancel` referenced but ❓ unconfirmed; otherwise set
`fulfillment_status: "canceled"`.

## 5. PO status ⚠️
`fulfillment_status` is a **String, not a strict enum** — accepts custom statuses.
Defaults: **Pending, Closed, Canceled**. Accounts can define custom statuses (e.g.
"In Transit"). Change via `fulfillment_status` on create/update, or
`purchase_order_close`. ❓ Confirm exact wire spelling of "partially received" /
"received".

## 6. PO query / received qty ✅
`purchase_order(id:)` and `purchase_orders` return header + `vendor` + `line_items`
with `sku, vendor_sku, quantity, quantity_received, quantity_rejected,
fulfillment_status`. **No `quantity_pending`** — compute `quantity -
quantity_received`. Received qty can be **polled** (plain fields) OR pushed via
webhook (§7); webhook preferred to save credits.

## 7. Webhooks ✅
`webhook_create { name, url, shop_name }` → returns `shared_signature_secret`
(**shown once** — store it). Also `webhook_update_url`, `webhook_delete`.
The **"PO Update"** webhook fires on PO create/update; payload:
```jsonc
{ "test": false,
  "purchase_order": { "po_number": "...", "po_id": ..., "po_uuid": "..." },
  "line_items": [ { "sku": "...", "quantity": 10, "quantity_received": 4,
                    "vendor_sku": "...", "vendor_id": ... } ] }
```
→ track received-per-SKU via `line_items[].quantity_received` (here it's the
**running total**, unlike the accumulative-delta update mutation in §4).
**Signature:** header `X-ShipHero-Hmac-Sha256`, HMAC-SHA256 over the raw body,
base64, constant-time compare. ⚠️ Known gotcha: header sometimes arrives empty —
build a fallback. Needs a **public HTTPS URL** (the droplet behind Caddy/Nginx).

## 8. Rate limits ✅
Credit pool ~**4004** (some accounts 2002 — ⚠️ verify yours), refill **60/sec**.
Every response can return `complexity` (cost). Pass `analyze: true` to price a
query without running it. Keep `first` modest; ShipHero refunds unused credits.
Throttle errors carry `remaining_credits` + `time_remaining` (back off on it).

## 9. PO bulk CSV upload ⚠️
Dashboard CSV upload **does not** create vendors or set product vendor SKUs (do
those first). **No commas** in fields. Supports `Sell Ahead` and `Status` columns;
`Status` accepts Pending/Closed/Canceled + custom statuses. ❓ The exact v3 header
row isn't published in docs — **but we verified ours against a real, successful
upload** (`samples/golden_shiphero_po_upload.csv`), which is authoritative.

## Verify-first list before building Phase 2–3
1. `vendor_create` exact name/input/return (§3).
2. `purchase_order_cancel` vs `purchase_order_close` (§4).
3. Whether `purchase_order_update` can add/remove line items; re-confirm
   `quantity_received` is accumulative (§4).
4. Exact `fulfillment_status` strings; remember custom statuses (§5).
5. Connection nesting + cursor arg names (§2/§6).
6. Live PO Update payload casing; plan for empty-HMAC header (§7).
7. Your account's real credit pool (§8).
