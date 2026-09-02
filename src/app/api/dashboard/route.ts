import { getCachedSummaries } from "@/lib/po-cache";
import { listAliases } from "@/lib/vendors";
import { getPoDates } from "@/lib/po-dates";
import { getOpsStats } from "@/lib/ops-cache";
import { listCachedReturns } from "@/lib/returns-cache";
import { deriveSummary } from "@/lib/returns-types";
import { syncStatus } from "@/lib/sync-registry";
import { todayUkYmd, ukYmd } from "@/lib/uk-time";
import type { PoSummary } from "@/lib/shiphero/po-pull";
import type { AttnRow, DashboardData, MonthBar, RecvRow, WeekRow } from "@/lib/dashboard-types";

export const dynamic = "force-dynamic";

// GET /api/dashboard — the morning briefing, aggregated from LOCAL CACHES only
// (PO cache, ops snapshot, returns cache, sync stamps). Never calls ShipHero;
// the background scheduler + the page's Sync button keep those caches fresh.

const DONE = new Set(["closed", "canceled", "cancelled", "delivered"]);
const isOpenPo = (p: PoSummary) => !DONE.has(p.status.trim().toLowerCase());
const num = (s: string | null) => Number(s ?? 0) || 0;
const toCome = (p: PoSummary) => Math.max(0, p.unitsOrdered - p.unitsReceived);
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const wcLabel = (ymd: string) => `w/c ${Number(ymd.slice(8, 10))} ${MONTHS_SHORT[Number(ymd.slice(5, 7)) - 1]}`;

export async function GET() {
  try {
    const [{ pos: rawPos }, aliases, ops, returnRows, jobs] = await Promise.all([
      getCachedSummaries(),
      listAliases(),
      getOpsStats(),
      listCachedReturns(),
      syncStatus(),
    ]);

    // Same PO universe as PO History's default view: mapped vendors, real value.
    const mapped = new Set(aliases.map((a) => a.name.toLowerCase()));
    const posAll = rawPos.filter((p) => num(p.totalPrice) !== 0 && p.vendorName && mapped.has(p.vendorName.toLowerCase()));
    const dates = await getPoDates(posAll.map((p) => p.poNumber));
    const expected = (p: PoSummary) => dates[p.poNumber]?.delivery ?? p.poDate?.slice(0, 10) ?? null;

    const today = todayUkYmd();
    const open = posAll.filter(isOpenPo);

    // ---- PO position ----
    const overdueList = open.filter((p) => { const e = expected(p); return !!e && e < today; });
    const landingEnd = addDays(today, 14);
    const landing = open.filter((p) => { const e = expected(p); return !!e && e >= today && e <= landingEnd; });
    const missing = open.filter((p) => !dates[p.poNumber]?.exFactory || !expected(p));
    const poPosition = {
      valueOnOrder: open.reduce((a, p) => a + num(p.totalPrice), 0),
      openCount: open.length,
      vendorCount: new Set(open.map((p) => p.vendorName ?? "—")).size,
      unitsToCome: open.reduce((a, p) => a + toCome(p), 0),
      datedCount: open.filter((p) => expected(p)).length,
      landing14Units: landing.reduce((a, p) => a + toCome(p), 0),
      landing14Pos: landing.length,
      overdueCount: overdueList.length,
      overdueUnits: overdueList.reduce((a, p) => a + toCome(p), 0),
      overdueWorstDays: overdueList.reduce((a, p) => Math.max(a, daysBetween(expected(p)!, today)), 0),
      missingCount: missing.length,
    };

    // ---- landing weeks (overdue + this week and the next three) ----
    const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
    const weeks: WeekRow[] = [{
      label: "Overdue", sub: "before today", late: true, href: "/history?win=overdue",
      units: poPosition.overdueUnits, pos: poPosition.overdueCount,
    }];
    for (let i = 0; i < 4; i++) {
      const start = addDays(monday, i * 7);
      const end = addDays(start, 6);
      const inWeek = open.filter((p) => { const e = expected(p); return !!e && e >= today && e >= start && e <= end; });
      weeks.push({
        label: wcLabel(start), sub: i === 0 ? "this week" : i === 1 ? "next week" : "", late: false, href: "/calendar",
        units: inWeek.reduce((a, p) => a + toCome(p), 0), pos: inWeek.length,
      });
    }

    // ---- receiving: POs actually on their way ----
    const rank = { over: 0, part: 1, awaiting: 2, complete: 3 } as const;
    const receiving: RecvRow[] = open
      .filter((p) => p.unitsOrdered > 0 && p.status.trim().toLowerCase() === "in transit")
      .map((p): RecvRow => ({
        po: p,
        pct: Math.min(100, Math.round((p.unitsReceived / p.unitsOrdered) * 100)),
        state: p.unitsReceived > p.unitsOrdered ? "over" : p.unitsReceived === 0 ? "awaiting" : p.unitsReceived >= p.unitsOrdered ? "complete" : "part",
      }))
      .sort((a, b) => rank[a.state] - rank[b.state] || b.pct - a.pct)
      .slice(0, 10);

    // ---- needs attention (each row deep-links to the tool that fixes it) ----
    const attention: AttnRow[] = [];
    for (const p of open.filter((p) => p.unitsOrdered > 0 && p.unitsReceived > p.unitsOrdered).slice(0, 3)) {
      attention.push({ sev: "bad", strong: p.poNumber, text: `over-received +${p.unitsReceived - p.unitsOrdered} — check for a double book-in`, href: `/po-unreceive?po=${encodeURIComponent(p.poNumber)}`, cta: "Un-receive ›" });
    }
    if (overdueList.length) {
      attention.push({ sev: "bad", strong: `${overdueList.length} PO${overdueList.length === 1 ? "" : "s"}`, text: `past expected date · worst ${poPosition.overdueWorstDays} days`, href: "/history?win=overdue", cta: "Chase list ›" });
    }
    for (const p of open.filter((p) => p.unitsOrdered > 0 && p.unitsReceived === p.unitsOrdered).slice(0, 3)) {
      attention.push({ sev: "info", strong: p.poNumber, text: `fully booked in but still “${p.status}” — mark it Delivered`, href: `/history?q=${encodeURIComponent(p.poNumber)}`, cta: "Open PO ›" });
    }
    if (missing.length) {
      attention.push({ sev: "warn", strong: `${missing.length} PO${missing.length === 1 ? "" : "s"}`, text: "missing an ex-factory or expected date", href: "/history?missing=1", cta: "Amend dates ›" });
    }
    for (const j of jobs) {
      if (j.lastRun && !j.lastRun.ok) attention.push({ sev: "warn", strong: j.label, text: `last sync failed — ${(j.lastRun.error ?? "unknown error").slice(0, 80)}`, href: "#", cta: "" });
    }

    // ---- returns week (cached rows; same derivation the Returns page uses) ----
    const nowIso = new Date().toISOString();
    const weekFromIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const rsum = deriveSummary(returnRows, weekFromIso, nowIso, nowIso);
    const reasonTotal = Math.max(1, rsum.reasons.reduce((a, r) => a + r.units, 0));
    const returnsWeek = {
      opened: rsum.total,
      processed: rsum.processedReturns,
      valueOpen: Math.round(rsum.valueOpen),
      faultyUnits: rsum.faulty,
      faultyPct: rsum.unitsExpected ? Math.round((rsum.faulty / rsum.unitsExpected) * 1000) / 10 : 0,
      reasons: rsum.reasons.slice(0, 5).map((r) => ({ key: r.key, units: r.units, pct: Math.round((r.units / reasonTotal) * 100) })),
    };

    // ---- order value by expected month (window around the current month) ----
    const byMonth = new Map<string, { value: number; pos: number }>();
    for (const p of posAll) {
      const e = expected(p);
      if (!e) continue;
      const ym = e.slice(0, 7);
      const cur = byMonth.get(ym) ?? { value: 0, pos: 0 };
      cur.value += num(p.totalPrice);
      cur.pos += 1;
      byMonth.set(ym, cur);
    }
    const sorted = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const curYm = today.slice(0, 7);
    let idx = sorted.findIndex(([ym]) => ym >= curYm);
    if (idx === -1) idx = sorted.length - 1;
    const from = Math.max(0, idx - 3);
    const months: MonthBar[] = sorted.slice(from, from + 8).map(([ym, v]) => ({ ym, value: Math.round(v.value), pos: v.pos, current: ym === curYm }));

    const data: DashboardData = {
      today: {
        shippedOrders: ops ? ops.shippedOrders : null,
        shippedUnits: ops?.shippedUnits ?? 0,
        shippedByHour: ops?.shippedByHour ?? [],
        totalOpen: ops?.totalOpen ?? 0,
        readyTotal: ops?.readyTotal ?? 0,
        waitingTotal: ops?.waitingTotal ?? 0,
        dueDhl: ops?.dueByCarrier?.dhl ?? 0,
        dueRm: ops?.dueByCarrier?.rm ?? 0,
        oldestReady: ops?.oldestReady ?? null,
        returnsOpenedToday: returnRows.filter((r) => ukYmd(r.createdAt) === today).length,
        returnsOpenedWeek: rsum.total,
        returnsProcessedWeek: rsum.processedReturns,
      },
      poPosition,
      weeks,
      receiving,
      attention: attention.slice(0, 8),
      returnsWeek,
      months,
      jobs: jobs.map((j) => ({ key: j.key, label: j.label, at: j.lastRun?.at ?? null, ok: j.lastRun?.ok ?? true, running: j.running, error: j.lastRun?.error })),
      generatedAt: nowIso,
    };
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to build the dashboard." }, { status: 500 });
  }
}
