import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sql } from "drizzle-orm";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as schema from "./schema";
import { shipheroVendors, vendorAliases, poStatuses, sizeCodes } from "./schema";
import { SHIPHERO_VENDOR_SEED, ALIAS_SEED, STATUS_SEED, SIZE_CODE_SEED } from "./seed-data";

// Single SQLite file on the droplet. Path is overridable via DATABASE_PATH so the
// container can point at a mounted volume. Swap to Postgres later = change this file.
const dbPath = process.env.DATABASE_PATH ?? "data.db";

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { schema };

// Self-init: run migrations (idempotent) and seed vendors if empty, so a fresh
// droplet/container comes up ready with no manual steps. Guarded to run once.
let initialized = false;
export function initDb() {
  if (initialized) return;
  initialized = true;
  const migrationsDir = resolve(process.env.MIGRATIONS_DIR ?? "drizzle");
  if (existsSync(migrationsDir)) {
    try {
      migrate(db, { migrationsFolder: migrationsDir });
    } catch (err) {
      console.error("[db] migration failed:", err);
    }
  }
  try {
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM shiphero_vendors")
      .get() as { n: number };
    if (row.n === 0) {
      for (const v of SHIPHERO_VENDOR_SEED) {
        db.insert(shipheroVendors).values(v).onConflictDoNothing({ target: shipheroVendors.name }).run();
      }
      // map confirmed aliases onto their seeded vendor
      const all = sqlite.prepare("SELECT id, name FROM shiphero_vendors").all() as {
        id: number;
        name: string;
      }[];
      const byName = new Map(all.map((v) => [v.name, v.id]));
      for (const a of ALIAS_SEED) {
        const vid = byName.get(a.vendorName);
        if (vid) {
          db.insert(vendorAliases)
            .values({ alias: a.alias, vendorId: vid })
            .onConflictDoNothing({ target: vendorAliases.alias })
            .run();
        }
      }
      console.log(`[db] seeded ${SHIPHERO_VENDOR_SEED.length} ShipHero vendors + ${ALIAS_SEED.length} aliases`);
    }

    const statusRow = sqlite
      .prepare("SELECT COUNT(*) AS n FROM po_statuses")
      .get() as { n: number };
    if (statusRow.n === 0) {
      for (const s of STATUS_SEED) {
        db.insert(poStatuses)
          .values({
            name: s.name,
            isSystem: s.isSystem ?? false,
            includeInOnOrder: s.includeInOnOrder ?? false,
            includeInSellAhead: s.includeInSellAhead ?? false,
            sortOrder: s.sortOrder,
          })
          .onConflictDoNothing({ target: poStatuses.name })
          .run();
      }
      console.log(`[db] seeded ${STATUS_SEED.length} PO statuses`);
    }

    const sizeRow = sqlite.prepare("SELECT COUNT(*) AS n FROM size_codes").get() as { n: number };
    if (sizeRow.n === 0) {
      for (const s of SIZE_CODE_SEED) {
        db.insert(sizeCodes).values(s).onConflictDoNothing({ target: sizeCodes.label }).run();
      }
      console.log(`[db] seeded ${SIZE_CODE_SEED.length} size codes`);
    }
  } catch (err) {
    console.error("[db] seed check failed:", err);
  }
}

void sql; // keep import available for future raw queries
initDb();
