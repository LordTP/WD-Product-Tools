"use client";

import { useState } from "react";
import type { ShipheroVendor } from "@/db/schema";
import type { AliasRow } from "@/lib/vendors";

export function VendorManager({
  initialShipheroVendors,
  initialAliases,
  shipheroConnected,
}: {
  initialShipheroVendors: ShipheroVendor[];
  initialAliases: AliasRow[];
  shipheroConnected: boolean;
}) {
  const [shipheroVendors, setShipheroVendors] = useState(initialShipheroVendors);
  const [aliases, setAliases] = useState(initialAliases);
  const [alias, setAlias] = useState("");
  const [choice, setChoice] = useState(""); // vendor id or "__new__"
  const [newName, setNewName] = useState("");
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function syncFromShiphero() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/vendors/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed.");
      setShipheroVendors(data.shipheroVendors);
      setAliases(data.aliases);
      const s = data.summary;
      setSyncMsg({
        kind: "ok",
        text: `Synced ${s.fetched} vendors — ${s.added} new, ${s.updated} updated.`,
      });
    } catch (e) {
      setSyncMsg({ kind: "err", text: e instanceof Error ? e.message : "Sync failed." });
    } finally {
      setSyncing(false);
    }
  }

  const mappedVendorIds = new Set(aliases.map((a) => a.vendorId));
  const unmappedVendors = shipheroVendors.filter((v) => !mappedVendorIds.has(v.id));

  function resetForm() {
    setAlias("");
    setChoice("");
    setNewName("");
    setNewId("");
  }

  async function save() {
    if (!alias.trim()) return setError("Enter a short alias (e.g. SANDRA).");
    if (!choice) return setError("Pick a ShipHero vendor, or add a new one.");
    if (choice === "__new__" && !newName.trim()) return setError("Enter the ShipHero vendor name.");
    setBusy(true);
    setError(null);
    try {
      const body =
        choice === "__new__"
          ? { alias, newVendorName: newName.trim(), newVendorId: newId.trim() || null }
          : { alias, vendorId: Number(choice) };
      const res = await fetch("/api/vendors/alias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShipheroVendors(data.shipheroVendors);
      setAliases(data.aliases);
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function removeAlias(id: number) {
    if (!confirm("Remove this alias mapping?")) return;
    const res = await fetch("/api/vendors/alias", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (res.ok) {
      setShipheroVendors(data.shipheroVendors);
      setAliases(data.aliases);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-5 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm text-slate-900">Vendors</span>
          <span className="text-xs text-slate-400">
            {aliases.length} aliases · {shipheroVendors.length} ShipHero vendors
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <span
              className={`w-2 h-2 rounded-full ${shipheroConnected ? "bg-emerald-400" : "bg-slate-300"}`}
            />
            ShipHero {shipheroConnected ? "connected" : "not connected"}
          </span>
          <button
            onClick={syncFromShiphero}
            disabled={syncing || !shipheroConnected}
            title={shipheroConnected ? "Pull canonical vendor names from ShipHero" : "Add SHIPHERO_REFRESH_TOKEN to .env.local first"}
            className={`text-xs px-2.5 py-1.5 rounded-md flex items-center gap-1.5 ${
              shipheroConnected
                ? "bg-indigo-600 text-white hover:bg-indigo-700"
                : "bg-slate-100 text-slate-400 cursor-not-allowed"
            } disabled:opacity-60`}
          >
            <svg
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
              className={syncing ? "animate-spin" : ""}
            >
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            {syncing ? "Syncing…" : "Sync from ShipHero"}
          </button>
        </div>
      </header>
      {syncMsg && (
        <div
          className={`px-5 py-2 text-xs border-b ${
            syncMsg.kind === "ok"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-rose-50 border-rose-200 text-rose-700"
          }`}
        >
          {syncMsg.text}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto p-5 space-y-4">
        {/* Compact add bar */}
        <div className="bg-white rounded-lg border border-slate-200 p-3">
          <div className="flex items-end gap-2 flex-wrap">
            <label className="text-xs">
              <span className="text-slate-500 block mb-0.5">Alias *</span>
              <input
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="SANDRA"
                className="w-32 px-2 py-1.5 border border-slate-200 rounded text-sm font-mono uppercase"
              />
            </label>
            <span className="pb-2 text-slate-300">→</span>
            <label className="text-xs flex-1 min-w-[15rem]">
              <span className="text-slate-500 block mb-0.5">ShipHero vendor *</span>
              <select
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm bg-white"
              >
                <option value="">Select a ShipHero vendor…</option>
                {unmappedVendors.length > 0 && (
                  <optgroup label="Unmapped vendors">
                    {unmappedVendors.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </optgroup>
                )}
                {mappedVendorIds.size > 0 && (
                  <optgroup label="Already mapped">
                    {shipheroVendors.filter((v) => mappedVendorIds.has(v.id)).map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </optgroup>
                )}
                <option value="__new__">+ Add a new ShipHero vendor…</option>
              </select>
            </label>
            {choice === "__new__" && (
              <>
                <label className="text-xs">
                  <span className="text-slate-500 block mb-0.5">Exact vendor name *</span>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Dongguan … Co. Ltd (Name)"
                    className="w-64 px-2 py-1.5 border border-slate-200 rounded text-sm"
                  />
                </label>
                <label className="text-xs">
                  <span className="text-slate-500 block mb-0.5">Vendor ID</span>
                  <input
                    value={newId}
                    onChange={(e) => setNewId(e.target.value)}
                    placeholder="1359289"
                    className="w-28 px-2 py-1.5 border border-slate-200 rounded text-sm font-mono"
                  />
                </label>
              </>
            )}
            {(alias || choice) && (
              <button onClick={resetForm} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600">
                Clear
              </button>
            )}
            <button
              onClick={save}
              disabled={busy}
              className="text-xs font-medium px-4 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Add mapping"}
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
        </div>

        {/* Two tables side by side */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          {/* Alias mappings */}
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">Alias mappings</span>
              <span className="text-[11px] text-slate-400">{aliases.length}</span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="font-medium px-4 py-2 border-b border-slate-200 w-28">Alias</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200">ShipHero vendor</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200 text-right w-20">Action</th>
                </tr>
              </thead>
              <tbody>
                {aliases.map((a, i) => (
                  <tr key={a.id} className={i % 2 ? "bg-slate-50/60" : ""}>
                    <td className="px-4 py-2 border-b border-slate-100 font-mono text-xs font-medium">{a.alias}</td>
                    <td className="px-4 py-2 border-b border-slate-100 text-[13px]">{a.name}</td>
                    <td className="px-4 py-2 border-b border-slate-100 text-right">
                      <button onClick={() => removeAlias(a.id)} className="text-xs text-rose-600 hover:underline">Remove</button>
                    </td>
                  </tr>
                ))}
                {aliases.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-xs text-slate-400">No aliases yet. Add one above.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* ShipHero vendor reference */}
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">ShipHero vendors</span>
              <span className="text-[11px] text-slate-400">
                {mappedVendorIds.size}/{shipheroVendors.length} mapped
              </span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="font-medium px-4 py-2 border-b border-slate-200">Name</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200 w-20">ID</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200 w-20 text-center">Mapped</th>
                </tr>
              </thead>
              <tbody>
                {shipheroVendors.map((v, i) => (
                  <tr key={v.id} className={i % 2 ? "bg-slate-50/60" : ""}>
                    <td className="px-4 py-2 border-b border-slate-100 text-[13px]">{v.name}</td>
                    <td className="px-4 py-2 border-b border-slate-100 font-mono text-xs text-slate-400">{v.shipheroId ?? "—"}</td>
                    <td className="px-4 py-2 border-b border-slate-100 text-center">
                      {mappedVendorIds.has(v.id) ? <span className="text-xs text-emerald-600">✓</span> : <span className="text-xs text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
