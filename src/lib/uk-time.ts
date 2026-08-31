// ShipHero API timestamps are naive UTC ("2026-08-28T10:24:27" means 10:24 UTC).
// Wander Doll runs on Europe/London, which is UTC+1 in summer — so every display
// and every "today" window must convert. These helpers are the single source of
// truth for that; never render a ShipHero timestamp without them. Client-safe.

const asUtc = (iso: string): Date => new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);

const HM = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false });
const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" });
const YMD = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
const HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false });

/** "11:24" — London wall-clock for a ShipHero (naive-UTC) or real ISO timestamp. */
export function ukHM(iso: string): string {
  const d = asUtc(iso);
  return Number.isNaN(d.getTime()) ? "" : HM.format(d);
}
/** "28 Aug" in London time. */
export function ukDay(iso: string): string {
  const d = asUtc(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : DAY.format(d);
}
/** "2026-08-28" — the London calendar day the timestamp falls on. */
export function ukYmd(iso: string): string {
  const d = asUtc(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : YMD.format(d);
}
/** 0–23 London hour of the timestamp. */
export function ukHour(iso: string): number {
  const d = asUtc(iso);
  return Number.isNaN(d.getTime()) ? 0 : Number(HOUR.format(d)) % 24;
}
/** Today's date in London. */
export function todayUkYmd(): string {
  return YMD.format(new Date());
}
/** London midnight of a YMD, as a naive-UTC timestamp — for ShipHero query args
 *  and lexicographic comparison against naive-UTC event strings. */
export function ukDayStartUtcNaive(ymd: string): string {
  const probe = new Date(`${ymd}T12:00:00Z`);
  const offset = (Number(HOUR.format(probe)) % 24) - 12; // 1 during BST, 0 in winter
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCHours(d.getUTCHours() - offset);
  return d.toISOString().slice(0, 19);
}
/** 23:59:59 at the end of a London day, as naive UTC. */
export function ukDayEndUtcNaive(ymd: string): string {
  const d = new Date(`${ukDayStartUtcNaive(ymd)}Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCSeconds(d.getUTCSeconds() - 1);
  return d.toISOString().slice(0, 19);
}
