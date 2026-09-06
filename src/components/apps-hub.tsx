"use client";

// Warehouse → Apps: full-width launcher hub for the floor tools.
// Cards drill into a full-screen app view (state, not routes — the floor tablet
// never loses its place); deep-linkable via /apps?app=scan etc.
// Spec: Product/WAREHOUSE_FEATURES_MIGRATION_SPEC.md

import { useCallback, useEffect, useState } from "react";
import { InventoryExplorer } from "./inventory-explorer";
import { ScanApp } from "./scan-app";
import { PoScannerApp } from "./po-scanner-app";

type AppKey = "scan" | "inventory" | "po-scanner";

type AppCard = {
  key: AppKey;
  name: string;
  desc: string;
  meta: string;
  ready: boolean;
  icon: (p: { className?: string }) => React.ReactElement;
  tint: string; // icon square classes
};

const APPS: AppCard[] = [
  {
    key: "scan",
    name: "Scan",
    desc: "Point the camera (or a handheld scanner) at any barcode or bin label to see exactly what it is and where it lives.",
    meta: "Camera + wedge scanner",
    ready: true,
    icon: ScanIcon,
    tint: "bg-indigo-50 text-indigo-600",
  },
  {
    key: "inventory",
    name: "Inventory",
    desc: "Every SKU with every bin holding it — totals, per-bin quantities, search by product, location or barcode.",
    meta: "Whole-warehouse explorer",
    ready: true,
    icon: InventoryIcon,
    tint: "bg-emerald-50 text-emerald-600",
  },
  {
    key: "po-scanner",
    name: "PO Scanner",
    desc: "Scan returns and odd stock into a PO, push it to ShipHero, then book the lot into a RET bin and close it — all in one flow.",
    meta: "Build · push · book in",
    ready: true,
    icon: PoScanIcon,
    tint: "bg-amber-50 text-amber-600",
  },
];

const appName = (k: AppKey) => APPS.find((a) => a.key === k)?.name ?? k;

export function AppsHub({ initialApp }: { initialApp: string }) {
  const valid = (v: string): v is AppKey => APPS.some((a) => a.key === v);
  const [app, setApp] = useState<AppKey | null>(valid(initialApp) ? initialApp : null);

  // Keep the URL shareable/bookmarkable without remounting the page.
  const go = useCallback((next: AppKey | null) => {
    setApp(next);
    const url = next ? `/apps?app=${next}` : "/apps";
    window.history.replaceState(null, "", url);
  }, []);

  // Browser back returns to the launcher rather than leaving the page.
  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(window.location.search).get("app") ?? "";
      setApp(valid(p) ? p : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (app) return <AppFrame appKey={app} onBack={() => go(null)} />;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="p-4 lg:p-6 flex flex-col gap-5">
        {/* ink hero */}
        <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950 text-white px-6 py-7 lg:px-8">
          <p className="font-brand text-[13px] tracking-[0.25em] text-slate-400">WANDERDOLL</p>
          <h1 className="text-2xl lg:text-[28px] font-semibold mt-1.5">Apps</h1>
          <p className="text-sm text-slate-300 mt-1">Warehouse tools — scan it, find it, book it in.</p>
        </div>

        {/* launcher grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {APPS.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.key}
                onClick={() => go(a.key)}
                className="group text-left bg-white rounded-2xl border border-slate-200 p-5 flex flex-col gap-3 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all"
              >
                <div className="flex items-start justify-between">
                  <span className={`w-11 h-11 rounded-xl flex items-center justify-center ${a.tint}`}>
                    <Icon className="w-6 h-6" />
                  </span>
                  <span className="text-slate-300 group-hover:text-indigo-500 group-hover:translate-x-0.5 transition-all mt-1">
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" /></svg>
                  </span>
                </div>
                <div>
                  <p className="text-[15px] font-semibold text-slate-900">{a.name}</p>
                  <p className="text-[13px] text-slate-500 mt-1 leading-snug">{a.desc}</p>
                </div>
                <p className="mt-auto pt-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">
                  {a.ready ? a.meta : "Coming online soon"}
                </p>
              </button>
            );
          })}

          {/* Label Press — standalone page with its own password, plain link */}
          <a
            href="/barcodes"
            className="group text-left bg-white rounded-2xl border border-slate-200 p-5 flex flex-col gap-3 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all"
          >
            <div className="flex items-start justify-between">
              <span className="w-11 h-11 rounded-xl flex items-center justify-center bg-slate-100 text-slate-600">
                <LabelIcon className="w-6 h-6" />
              </span>
              <span className="text-slate-300 group-hover:text-indigo-500 transition-colors mt-1">
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" /></svg>
              </span>
            </div>
            <div>
              <p className="text-[15px] font-semibold text-slate-900">Label Press</p>
              <p className="text-[13px] text-slate-500 mt-1 leading-snug">Print Zebra barcode labels for any PO or product. Opens the standalone printer page.</p>
            </div>
            <p className="mt-auto pt-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">Standalone · own password</p>
          </a>

          {/* coming-soon slot */}
          <div className="rounded-2xl border-2 border-dashed border-slate-200 p-5 flex flex-col items-center justify-center text-center gap-1.5 min-h-[168px]">
            <span className="w-9 h-9 rounded-xl bg-slate-100 text-slate-300 flex items-center justify-center">
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
            </span>
            <p className="text-[13px] font-medium text-slate-400">More apps coming</p>
            <p className="text-[11px] text-slate-300">Got an idea? Tell Tom.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// Full-screen frame every app renders inside: back button + title bar, then the
// app body. Placeholder body until each app is built (spec build order 1–4).
function AppFrame({ appKey, onBack }: { appKey: AppKey; onBack: () => void }) {
  const card = APPS.find((a) => a.key === appKey)!;
  const Icon = card.icon;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="bg-white border-b border-slate-200 px-4 lg:px-6 h-14 flex items-center gap-3 shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900 transition-colors -ml-1 px-1 py-1 rounded"
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
          Apps
        </button>
        <span className="w-px h-5 bg-slate-200" />
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${card.tint}`}>
          <Icon className="w-4 h-4" />
        </span>
        <h1 className="text-[15px] font-semibold text-slate-900">{appName(appKey)}</h1>
      </div>

      {appKey === "inventory" ? (
        <InventoryExplorer />
      ) : appKey === "scan" ? (
        <ScanApp />
      ) : appKey === "po-scanner" ? (
        <PoScannerApp />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center p-6">
          <div className="text-center max-w-sm">
            <span className={`w-14 h-14 rounded-2xl mx-auto flex items-center justify-center ${card.tint}`}>
              <Icon className="w-7 h-7" />
            </span>
            <p className="text-[15px] font-semibold text-slate-900 mt-4">{card.name} is being built</p>
            <p className="text-[13px] text-slate-500 mt-1.5 leading-snug">{card.desc}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ScanIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h1M11 12h2M16 12h1" strokeWidth="2.5" />
    </svg>
  );
}
function InventoryIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 4v16M15 10v10" />
    </svg>
  );
}
function PoScanIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h1M11 13h2M15 13h1M8 17h1M11 17h2M15 17h1" />
    </svg>
  );
}
function LabelIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M20.59 13.41 12 22l-8.59-8.59A2 2 0 0 1 3 12V4a2 2 0 0 1 2-2h8a2 2 0 0 1 1.41.59L22 10.17a2 2 0 0 1 0 2.83z" transform="rotate(90 12 12)" />
      <circle cx="7.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
