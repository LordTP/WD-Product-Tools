// Read-only SKU existence check for the push pre-flight. A variant SKU must
// already exist as a product in ShipHero or the PO line orphans on upload
// (spec §2.3 rule 5). Uses the cheap singular `product(sku:)` query, batched.

import { shipheroGraphql, ShipheroError } from "./client";

interface ProductResult {
  product?: { data?: { sku?: string } | null } | null;
}

const BATCH = 4; // small parallel batches: fast-ish without draining credits

export async function checkSkusExist(skus: string[]): Promise<{ missing: string[] }> {
  const distinct = [...new Set(skus.map((s) => s.trim()).filter(Boolean))];
  const existing = new Set<string>();

  for (let i = 0; i < distinct.length; i += BATCH) {
    const batch = distinct.slice(i, i + BATCH);
    const found = await Promise.all(
      batch.map(async (sku) => {
        const escaped = sku.replace(/"/g, '\\"');
        try {
          const { data } = await shipheroGraphql<ProductResult>(
            `query { product(sku: "${escaped}") { data { sku } } }`,
          );
          return data.product?.data?.sku ? sku : null;
        } catch (err) {
          // A throttle must NOT be misread as "missing" — surface it.
          if (err instanceof ShipheroError && err.kind === "throttled") throw err;
          return null; // not-found / lookup error → treat as missing
        }
      }),
    );
    for (const s of found) if (s) existing.add(s);
  }

  return { missing: distinct.filter((s) => !existing.has(s)) };
}
