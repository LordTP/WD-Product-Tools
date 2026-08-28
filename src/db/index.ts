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
  // Ensure the key/value state table exists (idempotent; not part of a migration).
  try {
    sqlite.exec("CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)");
  } catch (err) {
    console.error("[db] app_state init failed:", err);
  }
  // Returns pick-face (PICK-00) contents cache (idempotent; not in a migration).
  try {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS shiphero_bin_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bin_name TEXT NOT NULL,
        sku TEXT NOT NULL,
        product_name TEXT,
        quantity INTEGER NOT NULL DEFAULT 0,
        landed_at TEXT,
        item_updated_at TEXT,
        dest_face TEXT,
        dest_qty INTEGER,
        synced_at TEXT
      )`,
    );
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_bin_cache_bin_sku ON shiphero_bin_cache (bin_name, sku)");
    // additive for installs created before candidates were stored
    try {
      sqlite.exec("ALTER TABLE shiphero_bin_cache ADD COLUMN dest_candidates TEXT");
    } catch {
      /* column already exists */
    }
  } catch (err) {
    console.error("[db] shiphero_bin_cache init failed:", err);
  }
  // Log of cycle counts created from this app (idempotent; not in a migration).
  try {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS cycle_count_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shiphero_id TEXT NOT NULL UNIQUE,
        legacy_id TEXT,
        name TEXT NOT NULL,
        count_type TEXT,
        items TEXT NOT NULL,
        sku_count INTEGER NOT NULL DEFAULT 0,
        max_qty INTEGER,
        due_date TEXT,
        status TEXT,
        queue_status TEXT,
        progress INTEGER,
        counted INTEGER,
        uncounted INTEGER,
        skus_total INTEGER,
        skus_counted INTEGER,
        sh_started_at TEXT,
        sh_ended_at TEXT,
        created_at TEXT NOT NULL,
        synced_at TEXT
      )`,
    );
  } catch (err) {
    console.error("[db] cycle_count_log init failed:", err);
  }
  // Warehouse activity day-cache (idempotent; not in a migration).
  try {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS warehouse_day_cache (
        date TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        generated_at TEXT NOT NULL
      )`,
    );
  } catch (err) {
    console.error("[db] warehouse_day_cache init failed:", err);
  }
  // Per-PO sheet dates ShipHero can't hold (idempotent; not in a migration).
  try {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS po_dates (
        po_number TEXT PRIMARY KEY,
        order_sent TEXT,
        ex_factory TEXT,
        delivery TEXT,
        updated_at TEXT
      )`,
    );
  } catch (err) {
    console.error("[db] po_dates init failed:", err);
  }
  // PO date revision log (idempotent; not in a migration).
  try {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS po_date_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_number TEXT NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        changed_at TEXT NOT NULL
      )`,
    );
  } catch (err) {
    console.error("[db] po_date_log init failed:", err);
  }
  // PO un-receive audit log (idempotent; not in a migration).
  try {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS po_unreceive_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_number TEXT NOT NULL,
        sku TEXT NOT NULL,
        unreceived INTEGER NOT NULL DEFAULT 0,
        stock_removed TEXT,
        ok INTEGER NOT NULL DEFAULT 1,
        result TEXT,
        created_at TEXT NOT NULL
      )`,
    );
  } catch (err) {
    console.error("[db] po_unreceive_log init failed:", err);
  }
  // PO history cache (idempotent; not in a migration).
  try {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS po_history_cache (
        po_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      )`,
    );
  } catch (err) {
    console.error("[db] po_history_cache init failed:", err);
  }
  // Returns (Swap RMA) cache (idempotent; not in a migration).
  try {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS returns_cache (
        id TEXT PRIMARY KEY,
        legacy_id INTEGER,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        is_v2 INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        synced_at TEXT
      )`,
    );
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_returns_cache_created ON returns_cache (created_at)");
  } catch (err) {
    console.error("[db] returns_cache init failed:", err);
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
