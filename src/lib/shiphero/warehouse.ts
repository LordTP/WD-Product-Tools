// Resolve the ShipHero warehouse_id (required to create a PO). The account has a
// single "Primary" warehouse, so we fetch it automatically — no env var needed —
// with an env override if ever required. Cached in memory after first fetch.

import { shipheroGraphql } from "./client";

let cached: string | null = null;

export async function getWarehouseId(): Promise<string> {
  if (process.env.SHIPHERO_WAREHOUSE_ID) return process.env.SHIPHERO_WAREHOUSE_ID;
  if (cached) return cached;

  const { data } = await shipheroGraphql<{
    account?: { data?: { warehouses?: Array<{ id?: string }> } };
  }>(`query { account { data { warehouses { id legacy_id } } } }`);

  const id = data.account?.data?.warehouses?.[0]?.id;
  if (!id) throw new Error("No ShipHero warehouse found on the account.");
  cached = id;
  return id;
}
