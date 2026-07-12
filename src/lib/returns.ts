// Server-side helpers for the Returns page: persisted settings (which statuses
// count as exportable, the two condition labels, last-export time) in app_state.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appState } from "@/db/schema";
import { DEFAULT_RETURNS_SETTINGS, type ReturnsSettings } from "@/lib/returns-derive";

const KEY = "returns_settings";

async function getState(key: string): Promise<string | null> {
  const [r] = await db.select().from(appState).where(eq(appState.key, key));
  return r?.value ?? null;
}
async function setState(key: string, value: string): Promise<void> {
  await db
    .insert(appState)
    .values({ key, value })
    .onConflictDoUpdate({ target: appState.key, set: { value } });
}

export async function getReturnsSettings(): Promise<ReturnsSettings> {
  const raw = await getState(KEY);
  if (!raw) return { ...DEFAULT_RETURNS_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<ReturnsSettings>;
    return {
      exportStatuses:
        Array.isArray(parsed.exportStatuses) && parsed.exportStatuses.length
          ? parsed.exportStatuses
          : DEFAULT_RETURNS_SETTINGS.exportStatuses,
      sellableLabel: parsed.sellableLabel || DEFAULT_RETURNS_SETTINGS.sellableLabel,
      damagedLabel: parsed.damagedLabel || DEFAULT_RETURNS_SETTINGS.damagedLabel,
      lastExportAt: parsed.lastExportAt ?? null,
    };
  } catch {
    return { ...DEFAULT_RETURNS_SETTINGS };
  }
}

export async function saveReturnsSettings(patch: Partial<ReturnsSettings>): Promise<ReturnsSettings> {
  const current = await getReturnsSettings();
  const next: ReturnsSettings = {
    exportStatuses:
      Array.isArray(patch.exportStatuses) && patch.exportStatuses.length
        ? patch.exportStatuses
        : current.exportStatuses,
    sellableLabel: patch.sellableLabel ?? current.sellableLabel,
    damagedLabel: patch.damagedLabel ?? current.damagedLabel,
    lastExportAt: patch.lastExportAt !== undefined ? patch.lastExportAt : current.lastExportAt,
  };
  await setState(KEY, JSON.stringify(next));
  return next;
}

/** Stamp the last-export time to now (called after a successful CSV download). */
export async function markReturnsExported(nowISO: string): Promise<void> {
  await saveReturnsSettings({ lastExportAt: nowISO });
}
