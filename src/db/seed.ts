import { db } from "./index";
import { shipheroVendors, vendorAliases } from "./schema";
import { SHIPHERO_VENDOR_SEED, ALIAS_SEED } from "./seed-data";
import { eq } from "drizzle-orm";

// Manual reseed: `npm run db:seed`. Boot-time self-init (db/index.ts) also seeds
// an empty DB, so this is mainly for re-running against an existing one.
async function main() {
  for (const v of SHIPHERO_VENDOR_SEED) {
    await db.insert(shipheroVendors).values(v).onConflictDoNothing({ target: shipheroVendors.name });
  }
  for (const a of ALIAS_SEED) {
    const [v] = await db.select().from(shipheroVendors).where(eq(shipheroVendors.name, a.vendorName));
    if (v) {
      await db
        .insert(vendorAliases)
        .values({ alias: a.alias, vendorId: v.id })
        .onConflictDoNothing({ target: vendorAliases.alias });
    }
  }
  const vendors = await db.select().from(shipheroVendors);
  const aliases = await db.select().from(vendorAliases);
  console.log(`Seeded ${vendors.length} ShipHero vendors, ${aliases.length} aliases.`);
}

main();
