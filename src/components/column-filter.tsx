"use client";

// Excel-style per-column filter — a funnel icon on a table header opens a
// multi-select tickbox list (search, Select all, (Blanks), Apply/Clear). Values
// are computed client-side from the already-loaded rows, so it's instant and
// hits no API. Filters across columns combine (AND), Excel-style.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const BLANK_SENTINEL = "__BLANK__";

interface Props {
  label: string;
  /** Distinct non-blank values available for this column (already narrowed by
   *  the other columns' active filters). */
  values: string[];
  hasBlanks: boolean;
  /** Current selection for this column. [] = no filter (all pass). */
  selected: string[];
  onApply: (values: string[]) => void;
}

export function ColumnFilter({ label, values, hasBlanks, selected, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const isFiltered = selected.length > 0;

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    setDraft(new Set(selected));
    setSearch("");
    const rect = triggerRef.current.getBoundingClientRect();
    const W = 240, H = 360;
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + W > window.innerWidth - 8) left = Math.max(8, window.innerWidth - W - 8);
    if (top + H > window.innerHeight - 8) top = Math.max(8, rect.top - H - 4);
    setPos({ top, left });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popupRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? values.filter((v) => v.toLowerCase().includes(q)) : values;
  }, [values, search]);

  const allVisibleSelected = visible.length > 0 && visible.every((v) => draft.has(v));

  const toggle = (v: string) =>
    setDraft((p) => {
      const n = new Set(p);
      if (n.has(v)) n.delete(v); else n.add(v);
      return n;
    });

  const toggleAll = () =>
    setDraft((p) => {
      const n = new Set(p);
      if (allVisibleSelected) visible.forEach((v) => n.delete(v));
      else visible.forEach((v) => n.add(v));
      return n;
    });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={isFiltered ? `${selected.length} selected` : "Filter"}
        className={`inline-flex items-center justify-center w-4 h-4 rounded transition-colors shrink-0 ${
          isFiltered ? "text-indigo-600 bg-indigo-50" : "text-slate-300 hover:text-slate-600 hover:bg-slate-200"
        }`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill={isFiltered ? "currentColor" : "none"} stroke="currentColor" strokeWidth={isFiltered ? 0 : 2}>
          <path d="M22 3H2l8 9.46V19l4 2v-8.54z" />
        </svg>
      </button>

      {open && pos && typeof window !== "undefined" && createPortal(
        <div
          ref={popupRef}
          className="fixed z-[100] w-[240px] bg-white rounded-lg shadow-xl ring-1 ring-slate-200 flex flex-col overflow-hidden normal-case tracking-normal"
          style={{ top: pos.top, left: pos.left, maxHeight: 360 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-900 truncate">{label}</span>
            <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 text-sm leading-none">×</button>
          </div>

          <div className="px-2 py-2 border-b border-slate-100">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              autoFocus
              className="w-full px-2 py-1 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto py-1 thin-scroll">
            {visible.length === 0 && !hasBlanks ? (
              <p className="text-center py-6 text-xs text-slate-400 italic">No values</p>
            ) : (
              <>
                <label className="flex items-center gap-2 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer">
                  <input type="checkbox" className="w-3 h-3" checked={allVisibleSelected} onChange={toggleAll} />
                  {allVisibleSelected ? "Deselect all" : "Select all"} ({visible.length})
                </label>
                <div className="border-t border-slate-50 my-1" />
                {hasBlanks && !search.trim() && (
                  <label className="flex items-center gap-2 px-3 py-1 text-xs text-slate-500 italic hover:bg-slate-50 cursor-pointer">
                    <input type="checkbox" className="w-3 h-3" checked={draft.has(BLANK_SENTINEL)} onChange={() => toggle(BLANK_SENTINEL)} />
                    (Blanks)
                  </label>
                )}
                {visible.map((v) => (
                  <label key={v} className="flex items-center gap-2 px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 cursor-pointer">
                    <input type="checkbox" className="w-3 h-3" checked={draft.has(v)} onChange={() => toggle(v)} />
                    <span className="truncate">{v}</span>
                  </label>
                ))}
              </>
            )}
          </div>

          <div className="px-3 py-2 border-t border-slate-100 flex items-center justify-between bg-slate-50/60">
            <button
              onClick={() => { onApply([]); setOpen(false); }}
              disabled={!isFiltered}
              className="text-[11px] text-slate-500 hover:text-slate-700 disabled:opacity-40"
            >
              Clear
            </button>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setOpen(false)} className="px-2 py-1 text-[11px] text-slate-600 border border-slate-200 rounded hover:bg-white">Cancel</button>
              <button
                onClick={() => { onApply([...draft]); setOpen(false); }}
                className="px-2.5 py-1 text-[11px] font-semibold text-white bg-indigo-600 rounded hover:bg-indigo-700"
              >
                Apply
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
