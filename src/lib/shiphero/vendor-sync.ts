// Pull the ShipHero vendor list and upsert it into shiphero_vendors so our names
// match ShipHero byte-for-byte (spec §2.3 rule 4). Read-only against ShipHero.
//
// The exact `vendors` connection nesting varies by account/schema version, so the
// node extraction is defensive (handles data.vendors.data.edges and .edges).

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shipheroVendors } from "@/db/schema";
import { shipheroGraphql } from "./client";

// `vendors` takes no pagination args (verified via live introspection) — it
// returns the full list nested as data { edges { node } }.
const VENDORS_QUERY = `
  query Vendors {
    vendors {
      request_id
      complexity
      data {
        edges {
          node { id legacy_id name account_number }
        }
      }
    }
  }
`;

interface VendorNode {
  id?: string;
  legacy_id?: string | number;
  name?: string;
  account_number?: string;
}

// Tolerant extraction of { edges, pageInfo } from whatever wrapper ShipHero uses.
function extractConnection(data: unknown): {
  nodes: VendorNode[];
  hasNext: boolean;
  endCursor: string | null;
} {
  const root = (data as { vendors?: unknown })?.vendors as Record<string, unknown> | undefined;
  const conn = (root?.data ?? root) as Record<string, unknown> | undefined;
  const edges = (conn?.edges ?? []) as Array<{ node?: VendorNode }>;
  const pageInfo = (conn?.pageInfo ?? {}) as { hasNextPage?: boolean; endCursor?: string | null };
  return {
    nodes: edges.map((e) => e.node ?? {}).filter((n) => n.name),
    hasNext: Boolean(pageInfo.hasNextPage),
    endCursor: pageInfo.endCursor ?? null,
  };
}

export interface VendorSyncResult {
  fetched: number;
  added: number;
  updated: number;
}

export async function syncVendorsFromShiphero(): Promise<VendorSyncResult> {
  const result: VendorSyncResult = { fetched: 0, added: 0, updated: 0 };

  const { data } = await shipheroGraphql(VENDORS_QUERY);
  const { nodes } = extractConnection(data);

  for (const node of nodes) {
    const name = String(node.name).trim();
    if (!name) continue;
    const shipheroId = node.legacy_id != null ? String(node.legacy_id) : null;
    result.fetched += 1;

    const existing = await db
      .select()
      .from(shipheroVendors)
      .where(eq(shipheroVendors.name, name));

    if (existing[0]) {
      if (shipheroId && existing[0].shipheroId !== shipheroId) {
        await db
          .update(shipheroVendors)
          .set({ shipheroId })
          .where(eq(shipheroVendors.id, existing[0].id));
        result.updated += 1;
      }
    } else {
      await db.insert(shipheroVendors).values({ name, shipheroId });
      result.added += 1;
    }
  }

  return result;
}
