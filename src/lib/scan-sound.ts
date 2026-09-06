// Audible scan feedback (Web Audio — no assets). The "bing" matches the one the
// floor already knows from Will's scanner pages; the buzz is deliberately ugly
// so a missed/unknown scan is heard, not just seen.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = ctx || new AC();
    return ctx;
  } catch {
    return null;
  }
}

/** Call from a user gesture (Start camera / first input) to unlock audio under
 *  browser autoplay policies. */
export function primeAudio() {
  const c = audio();
  if (c && c.state === "suspended") void c.resume();
}

/** Accepted scan: a short two-note "bing". */
export function scanBing() {
  const c = audio();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.connect(g);
  g.connect(c.destination);
  o.type = "sine";
  o.frequency.setValueAtTime(784, c.currentTime); // G5
  o.frequency.setValueAtTime(1175, c.currentTime + 0.07); // D6 — the lift
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.35, c.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.32);
  o.start();
  o.stop(c.currentTime + 0.33);
}

/** Unknown code / failed scan: a low double buzz — audibly different from the bing. */
export function scanBuzz() {
  const c = audio();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.connect(g);
  g.connect(c.destination);
  o.type = "square";
  o.frequency.setValueAtTime(160, c.currentTime);
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.2, c.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.14);
  g.gain.exponentialRampToValueAtTime(0.2, c.currentTime + 0.2);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.38);
  o.start();
  o.stop(c.currentTime + 0.4);
}
