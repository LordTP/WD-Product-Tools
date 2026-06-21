"use client";

// Size Map admin — edit the size label → SKU code mapping used by the Products
// (Style Arcade) converter. "In range" sizes form the small→large expansion
// order; brackets (XS-S etc) are valid sizes but not part of the range.

import { useState } from "react";
import type { SizeCode } from "@/db/schema";

const EMPTY = { label: "", code: "", inOrder: true, sortOrder: 0 };

export function SizeManager({ initialSizes }: { initialSizes: SizeCode[] }) {
  const [sizes, setSizes] = useState(initialSizes);
  const [form, setForm] = useState({ ...EMPTY });
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!form.label.trim() || !form.code.trim()) {
      setError("Label and code are both required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sizes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSizes(data.sizes);
      setForm({ ...EMPTY });
      setEditingLabel(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Remove this size?")) return;
    const res = await fetch("/api/sizes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (res.ok) setSizes(data.sizes);
  }

  function edit(s: SizeCode) {
    setForm({ label: s.label, code: s.code, inOrder: s.inOrder, sortOrder: s.sortOrder });
    setEditingLabel(s.label);
    setError(null);
  }

  const inRange = sizes.filter((s) => s.inOrder).sort((a, b) => a.sortOrder - b.sortOrder);
  const brackets = sizes.filter((s) => !s.inOrder);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-5 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm text-slate-900">Size Map</span>
          <span className="text-xs text-slate-400">size label → SKU code (used by Products → Shopify)</span>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-5 space-y-4">
        {/* add / edit bar */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 max-w-3xl">
          <p className="text-xs font-semibold text-slate-700 mb-2">{editingLabel ? `Edit "${editingLabel}"` : "Add a size"}</p>
          <div className="flex items-end gap-2 flex-wrap">
            <label className="text-xs">
              <span className="text-slate-500 block mb-0.5">Label *</span>
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="XL" disabled={Boolean(editingLabel)} className="w-24 px-2 py-1.5 border border-slate-200 rounded text-sm font-mono uppercase disabled:bg-slate-50" />
            </label>
            <label className="text-xs">
              <span className="text-slate-500 block mb-0.5">SKU code *</span>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="93" className="w-24 px-2 py-1.5 border border-slate-200 rounded text-sm font-mono" />
            </label>
            <label className="text-xs">
              <span className="text-slate-500 block mb-0.5">Order</span>
              <input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} className="w-20 px-2 py-1.5 border border-slate-200 rounded text-sm font-mono" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-2">
              <input type="checkbox" checked={form.inOrder} onChange={(e) => setForm({ ...form, inOrder: e.target.checked })} />
              In size range
            </label>
            {(form.label || form.code) && (
              <button onClick={() => { setForm({ ...EMPTY }); setEditingLabel(null); }} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600">Clear</button>
            )}
            <button onClick={save} disabled={busy} className="text-xs font-medium px-4 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? "Saving…" : editingLabel ? "Update" : "Add size"}
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
          <p className="text-[10px] text-slate-400 mt-2">
            “In size range” sizes expand a range like XXS-XL (ordered small→large). Brackets (XS-S, S-M, L-XL) are valid single sizes but not part of the range.
          </p>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 max-w-4xl">
          <SizeTable title="Sizes (in range)" rows={inRange} showOrder onEdit={edit} onRemove={remove} />
          <SizeTable title="Bracket sizes" rows={brackets} onEdit={edit} onRemove={remove} />
        </div>
      </div>
    </div>
  );
}

function SizeTable({
  title, rows, showOrder, onEdit, onRemove,
}: {
  title: string;
  rows: SizeCode[];
  showOrder?: boolean;
  onEdit: (s: SizeCode) => void;
  onRemove: (id: number) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-700">{title}</span>
        <span className="text-[11px] text-slate-400">{rows.length}</span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50">
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
            <th className="font-medium px-4 py-2 border-b border-slate-200 w-24">Label</th>
            <th className="font-medium px-4 py-2 border-b border-slate-200 w-24">Code</th>
            {showOrder && <th className="font-medium px-4 py-2 border-b border-slate-200 w-16">Order</th>}
            <th className="font-medium px-4 py-2 border-b border-slate-200 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={s.id} className={i % 2 ? "bg-slate-50/60" : ""}>
              <td className="px-4 py-2 border-b border-slate-100 font-mono text-xs font-medium">{s.label}</td>
              <td className="px-4 py-2 border-b border-slate-100 font-mono text-xs">{s.code}</td>
              {showOrder && <td className="px-4 py-2 border-b border-slate-100 font-mono text-xs text-slate-400">{s.sortOrder}</td>}
              <td className="px-4 py-2 border-b border-slate-100 text-right whitespace-nowrap">
                <button onClick={() => onEdit(s)} className="text-xs text-indigo-600 hover:underline mr-3">Edit</button>
                <button onClick={() => onRemove(s.id)} className="text-xs text-rose-600 hover:underline">Remove</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={showOrder ? 4 : 3} className="px-4 py-6 text-center text-xs text-slate-400">None.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
