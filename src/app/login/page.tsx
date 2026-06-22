"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // Go where they were headed, defaulting to the dashboard.
      const from = new URLSearchParams(window.location.search).get("from");
      window.location.href = from && from.startsWith("/") ? from : "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incorrect password.");
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8 bg-slate-100">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-sm p-7">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-sm">WD</div>
          <span className="font-semibold text-slate-900">Product Tools</span>
        </div>
        <p className="text-xs text-slate-400 mb-5">Enter the team password to continue.</p>

        <label className="block text-xs text-slate-500 mb-1.5">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
          className={`w-full px-3 py-2 border rounded-md text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${error ? "border-rose-300" : "border-slate-200"}`}
          placeholder="••••••••"
        />
        {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

        <button
          type="submit"
          disabled={busy || !password}
          className="mt-5 w-full py-2 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
