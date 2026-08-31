// Carrier cutoff/collection times (London wall-clock, Mon–Fri) and the lane →
// carrier mapping. Client-safe. Order cutoff = latest order time for same-day
// dispatch; van = when the collection leaves.
export interface Carrier { key: "dhl" | "rm"; name: string; cutoff: string; van: string }
export const CARRIERS: Carrier[] = [
  { key: "dhl", name: "DHL", cutoff: "15:00", van: "15:30" },
  { key: "rm", name: "Royal Mail", cutoff: "17:00", van: "17:30" },
];
export const carrierForLane = (lane: string): Carrier["key"] => (/dhl/i.test(lane) ? "dhl" : "rm");
/** "Standard - Singles" → { family: "Standard", kind: "single" } (data-driven, unknown lanes pass through). */
export function laneFamily(lane: string): { family: string; kind: "single" | "multi" | null } {
  const m = lane.match(/^(.*?)\s*[-–]\s*(Singles?|Multis?)\s*$/i);
  if (!m) return { family: lane.trim() || "(none)", kind: null };
  return { family: m[1].trim(), kind: /multi/i.test(m[2]) ? "multi" : "single" };
}
