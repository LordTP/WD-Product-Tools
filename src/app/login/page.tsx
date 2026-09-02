"use client";

// Login — the split screen from the approved mockup (option B, panel 1+2).
// Left: greeting, live London clock, date + week number, and van countdowns
// (nothing private — carrier times are public knowledge). Right: the form.
// Auth flow unchanged: POST /api/auth/login, then honour ?from=.

import { useEffect, useState } from "react";
import { CARRIERS } from "@/lib/ops-cutoffs";

const BRAND = { fontFamily: "var(--font-brand)" };

interface LondonNow { h: number; m: number; weekday: string; dateLine: string; week: number }

function londonNow(): LondonNow {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short", timeZone: "Europe/London",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dateLine = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" }).format(now);
  // ISO week number
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const week = Math.ceil((((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1) / 7);
  return { h: Number(get("hour")) % 24, m: Number(get("minute")), weekday: get("weekday"), dateLine, week };
}

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

function vanText(t: LondonNow, van: string, orderBy: string): { text: React.ReactNode; gone: boolean } {
  if (t.weekday === "Sat" || t.weekday === "Sun") return { text: "vans rest — back Monday", gone: true };
  const left = toMin(van) - (t.h * 60 + t.m);
  if (left <= 0) return { text: `gone for today — back tomorrow`, gone: true };
  const hh = Math.floor(left / 60);
  const mm = String(left % 60).padStart(2, "0");
  return {
    text: (
      <>
        van in <b className="text-white tabular-nums">{hh ? `${hh}h ` : ""}{mm}m</b> · orders by {orderBy}
      </>
    ),
    gone: false,
  };
}

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<LondonNow | null>(null);

  // Clock starts client-side (the server can't know the visitor's moment);
  // first tick lands via a microtask so the effect body has no sync setState.
  useEffect(() => {
    const tick = () => setNow(londonNow());
    void Promise.resolve().then(tick);
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Incorrect password.");
      const from = new URLSearchParams(window.location.search).get("from");
      window.location.href = from && from.startsWith("/") ? from : "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incorrect password.");
      setBusy(false);
    }
  }

  const greeting = !now ? "Welcome." : now.h < 12 ? "Good morning." : now.h < 17 ? "Good afternoon." : "Good evening.";
  const dhl = CARRIERS.find((c) => c.key === "dhl")!;
  const rm = CARRIERS.find((c) => c.key === "rm")!;

  return (
    <div className="flex-1 grid grid-rows-[minmax(280px,45%)_1fr] lg:grid-rows-1 lg:grid-cols-[11fr_9fr] bg-white">
      {/* left — the day, nothing private */}
      <div className="relative overflow-hidden bg-[#17163a] text-[#eceafd] flex flex-col justify-between p-7 sm:p-8">
        <div aria-hidden className="absolute -right-56 -bottom-64 w-[640px] h-[640px] rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(99,91,255,.55), rgba(99,91,255,0) 62%)" }} />
        <div aria-hidden className="absolute -left-44 -top-56 w-[520px] h-[520px] rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(45,212,191,.16), rgba(45,212,191,0) 60%)" }} />

        <div className="relative">
          <div className="text-3xl text-white tracking-wide" style={BRAND}>WANDERDOLL</div>
          <div className="text-[10px] tracking-[0.3em] text-[#8f8ac9] mt-2">PRODUCT TOOLS</div>
        </div>

        <div className="relative">
          <p className="text-2xl sm:text-3xl font-medium text-white mb-1">{greeting}</p>
          <p className="text-white font-semibold tabular-nums leading-none text-6xl sm:text-7xl">
            {now ? `${String(now.h).padStart(2, "0")}:${String(now.m).padStart(2, "0")}` : "--:--"}
            <span className="text-lg sm:text-xl font-medium text-[#8f8ac9] tracking-widest ml-2 align-baseline">LDN</span>
          </p>
          <p className="text-sm text-[#a5a1e0] mt-3 mb-6">{now ? `${now.dateLine} · week ${now.week}` : " "}</p>
          <div className="flex flex-col gap-2.5">
            {([[dhl, "3pm"], [rm, "5pm"]] as const).map(([c, orderBy]) => {
              const v = now ? vanText(now, c.van, orderBy) : { text: "…", gone: false };
              return (
                <div key={c.key} className="flex items-center gap-3 text-[15px] text-[#dcdaf7]">
                  <span className={`font-bold text-[10px] tracking-wider px-2 py-1 rounded min-w-[44px] text-center ${c.key === "dhl" ? "bg-[#ffcc00] text-[#b3261e]" : "bg-[#e11d48] text-white"}`}>
                    {c.key === "dhl" ? "DHL" : "RM"}
                  </span>
                  <span className={v.gone ? "text-[#6c68a8]" : undefined}>{v.text}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="relative text-[11px] text-[#6c68a8] tracking-wide">
          Wander Doll internal · authorised team only
        </div>
      </div>

      {/* right — the door */}
      <div className="flex items-center justify-center p-8 bg-white">
        <form onSubmit={submit} className="w-full max-w-[320px]">
          <h1 className="text-xl font-semibold text-[#17163a] mb-1.5">Welcome back</h1>
          <p className="text-xs text-slate-400 mb-6">Enter the team password to open the tools.</p>

          <label htmlFor="password" className="block text-[11px] font-semibold uppercase tracking-wider text-[#6c68a8] mb-2">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            placeholder="••••••••"
            className={`w-full px-3.5 py-3 text-sm rounded-[10px] border outline-none transition bg-[#f6f6fb] focus:bg-white focus:border-indigo-600 focus:ring-[3px] focus:ring-indigo-600/15 ${error ? "border-rose-300" : "border-[#e3e2f2]"}`}
          />
          {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

          <button
            type="submit"
            disabled={busy || !password}
            className="mt-4 w-full py-3.5 bg-indigo-600 text-white rounded-[10px] text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition"
          >
            {busy ? "Checking…" : "Sign in"}
          </button>

          <p className="mt-6 text-[11px] text-slate-300">Wander Doll internal · authorised team only</p>
        </form>
      </div>
    </div>
  );
}
