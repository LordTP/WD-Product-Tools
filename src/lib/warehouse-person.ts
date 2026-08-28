// Client-safe "day report" for one person on the Operations page, derived
// entirely from the cached day's events. Produces both structured stats and
// plain-English sentences, so the hover card reads like a summary a manager
// would write, not a tooltip.

import { area, timeHM, TYPE_META, type EventType, type WarehouseDay, type WarehouseEvent } from "./warehouse-types";

export interface Session { start: string; end: string; kind: string; count: number }
export interface PersonReport {
  name: string;
  actions: number;
  units: number;
  first: string | null;
  last: string | null;
  activeHours: number;
  byType: Array<{ type: string; label: string; color: string; count: number; units: number; teamShare: number }>;
  byHour: number[];
  busiestHour: { hour: number; count: number } | null;
  longestGap: { from: string; to: string; minutes: number } | null;
  sessions: Session[];
  ordersPicked: number;
  totes: number;
  skus: number;
  bins: number;
  areas: Array<[string, number]>;
  topBins: Array<[string, number]>;
  pos: string[];
  rmas: number;
  shipped: number;
  teamActions: number;
  narrative: Array<{ title: string; text: string }>;
}

/** Coarse activity family used to segment the day into sessions. */
function family(t: EventType | string): string {
  switch (t) {
    case "picked": return "Picking";
    case "received": return "Booking in POs";
    case "putaway": return "Putting away";
    case "return-received": return "Returns desk";
    case "return-slotted": return "Slotting returns";
    case "replenish": return "Replenishing pick faces";
    case "consolidation": return "Consolidating stock";
    case "to-qc": case "to-faulty": case "qc-release": return "QC / faulty";
    case "adjust": return "Stock corrections";
    default: return "Moving stock";
  }
}

const mins = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 60_000;

export function personReport(day: WarehouseDay, name: string): PersonReport {
  const evs: WarehouseEvent[] = day.events
    .filter((e) => e.user === name && e.at)
    .sort((a, b) => a.at.localeCompare(b.at));
  const row = day.summary.byPerson.find((p) => p.name === name);
  const shipped = row?.shipped ?? 0;

  // team totals per type (for share)
  const teamByType = new Map<string, number>();
  for (const e of day.events) teamByType.set(e.type, (teamByType.get(e.type) ?? 0) + 1);

  const byTypeMap = new Map<string, { count: number; units: number }>();
  const byHour = Array.from({ length: 24 }, () => 0);
  const hourKeys = new Set<number>();
  const bins = new Map<string, number>();
  const areas = new Map<string, number>();
  const orders = new Set<string>();
  const totes = new Set<string>();
  const skus = new Set<string>();
  const pos = new Set<string>();
  const rmas = new Set<string>();
  let units = 0;

  for (const e of evs) {
    const t = byTypeMap.get(e.type) ?? { count: 0, units: 0 };
    t.count++; t.units += Math.abs(e.qty); byTypeMap.set(e.type, t);
    units += Math.abs(e.qty);
    const h = new Date(e.at).getHours();
    if (!Number.isNaN(h)) { byHour[h]++; hourKeys.add(h); }
    skus.add(e.sku);
    const bin = e.type === "picked" ? e.fromBin : (e.toBin && e.toBin !== "SHIPPED" ? e.toBin : e.fromBin);
    if (bin && !["PO", "RMA", "SHIPPED"].includes(bin) && !/^Tote/i.test(bin)) {
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
      areas.set(area(bin), (areas.get(area(bin)) ?? 0) + 1);
    }
    if (e.type === "picked") {
      const o = e.reason.match(/#+\s*(\d+)/)?.[1]; if (o) orders.add(o);
      const tote = e.reason.match(/tote\s+(\S+)/i)?.[1]; if (tote) totes.add(tote);
    }
    if (e.type === "received" && e.meta) pos.add(e.meta);
    if (e.type === "return-received" && e.meta) rmas.add(e.meta);
  }

  // sessions: consecutive events of one family, split on >20 min gaps or family change
  const sessions: Session[] = [];
  for (const e of evs) {
    const kind = family(e.type);
    const cur = sessions[sessions.length - 1];
    if (cur && cur.kind === kind && mins(cur.end, e.at) <= 20) { cur.end = e.at; cur.count++; }
    else sessions.push({ start: e.at, end: e.at, kind, count: 1 });
  }
  // drop tiny blips between bigger sessions (a single stray move) — merge into neighbours' story by keeping only ≥3 or standalone
  const meaningful = sessions.filter((s, i) => s.count >= 3 || sessions.length <= 3 || i === 0 || i === sessions.length - 1);

  const busiest: PersonReport["busiestHour"] = byHour.reduce<PersonReport["busiestHour"]>(
    (best, c, h) => (c > 0 && (!best || c > best.count) ? { hour: h, count: c } : best),
    null,
  );

  let longestGap: PersonReport["longestGap"] = null;
  for (let i = 1; i < evs.length; i++) {
    const g = mins(evs[i - 1].at, evs[i].at);
    if (g >= 25 && (!longestGap || g > longestGap.minutes)) longestGap = { from: evs[i - 1].at, to: evs[i].at, minutes: Math.round(g) };
  }

  const byType = [...byTypeMap.entries()]
    .map(([type, v]) => ({ type, label: (TYPE_META as Record<string, { label: string; color: string }>)[type]?.label ?? type, color: (TYPE_META as Record<string, { label: string; color: string }>)[type]?.color ?? "#64748b", ...v, teamShare: (teamByType.get(type) ?? 0) ? v.count / (teamByType.get(type) ?? 1) : 0 }))
    .sort((a, b) => b.count - a.count);

  const first = evs[0]?.at ?? null, last = evs[evs.length - 1]?.at ?? null;
  const teamActions = day.events.length + day.summary.byPerson.reduce((a, p) => a + p.shipped, 0);
  const actions = evs.length + shipped;

  // ---- narrative ----
  const n: Array<{ title: string; text: string }> = [];
  const say = (title: string, text: string) => n.push({ title, text });
  const firstName = name.split(/\s+/)[0];
  if (first && last) {
    say("On shift", `${firstName} was active from ${timeHM(first)} to ${timeHM(last)} — ${hourKeys.size} active hour${hourKeys.size === 1 ? "" : "s"}, ${actions} actions (${Math.round((actions / Math.max(1, teamActions)) * 100)}% of everything the team did).`);
  }
  const main = byType[0];
  if (main) {
    const parts: string[] = [];
    if (main.type === "picked") parts.push(`Mostly picking — ${main.count} picks for ${orders.size} order${orders.size === 1 ? "" : "s"} into ${totes.size} tote${totes.size === 1 ? "" : "s"}`);
    else if (main.type === "received") parts.push(`Mostly booking in — ${main.units} units across ${pos.size} PO${pos.size === 1 ? "" : "s"}`);
    else if (main.type === "return-received") parts.push(`Mostly on the returns desk — ${rmas.size} RMA${rmas.size === 1 ? "" : "s"} received (${main.units} units)`);
    else if (main.type === "putaway") parts.push(`Mostly putting away — ${main.units} units from receiving`);
    else if (main.type === "return-slotted") parts.push(`Mostly slotting returns — ${main.units} units into the returns wall`);
    else parts.push(`Mostly ${main.label.toLowerCase()} — ${main.count} actions, ${main.units} units`);
    if (main.teamShare >= 0.5 && (teamByType.get(main.type) ?? 0) > 5) parts.push(`that's ${Math.round(main.teamShare * 100)}% of the team's ${main.label.toLowerCase()} today`);
    say("Main job", `${parts.join("; ")}.`);
  }
  const others = byType.slice(1, 3).filter((t) => t.count >= 3);
  if (others.length) say("Also did", `${others.map((t) => `${t.label} (${t.count})`).join(" and ")}.`);
  if (shipped > 0) say("Shipping", `Packed and shipped ${shipped} order${shipped === 1 ? "" : "s"}.`);
  const topArea = [...areas.entries()].sort((a, b) => b[1] - a[1])[0];
  const topBin = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
  const binShare = topBin ? topBin[1] / Math.max(1, evs.length) : 0;
  if (topArea && topArea[1] >= 5) {
    say("Where", binShare >= 0.6
      ? `Spent most time in the ${topArea[0].toLowerCase()} area — almost everything went through ${topBin[0]} (${bins.size} bin${bins.size === 1 ? "" : "s"} touched all day).`
      : `Spent most time in the ${topArea[0].toLowerCase()} area, across ${bins.size} bin${bins.size === 1 ? "" : "s"}.`);
  }
  if (busiest && busiest.count >= 10) say("Peak", `${String(busiest.hour).padStart(2, "0")}:00–${String(busiest.hour + 1).padStart(2, "0")}:00 was the busiest hour, ${busiest.count} actions.`);
  if (longestGap && longestGap.minutes >= 45) say("Quiet spell", `Nothing logged ${timeHM(longestGap.from)}–${timeHM(longestGap.to)} (${longestGap.minutes} min) — break, packing, or off the scanner.`);

  return {
    name, actions, units, first, last, activeHours: hourKeys.size, byType, byHour,
    busiestHour: busiest, longestGap, sessions: meaningful,
    ordersPicked: orders.size, totes: totes.size, skus: skus.size, bins: bins.size,
    areas: [...areas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
    topBins: [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    pos: [...pos], rmas: rmas.size, shipped, teamActions, narrative: n,
  };
}
