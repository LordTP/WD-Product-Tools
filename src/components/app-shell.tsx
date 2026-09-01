"use client";

// App chrome: static sidebar on desktop, off-canvas drawer + hamburger top bar on
// mobile. The login page renders bare (no nav).

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // No nav chrome on the login screen or the standalone Barcode Label Press.
  // The Label Press scrolls the document (its content is taller than the
  // viewport), so it must NOT be wrapped in the h-full flex box — that pins the
  // white background to one viewport height and lets the body colour show below.
  if (pathname.startsWith("/barcodes")) return <>{children}</>;
  if (pathname === "/login") return <div className="flex h-full">{children}</div>;

  return (
    <div className="flex h-full">
      <Sidebar open={open} onNavigate={() => setOpen(false)} />

      {/* mobile drawer backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* mobile top bar (hidden on desktop) */}
        <div className="lg:hidden h-12 bg-white border-b border-slate-200 flex items-center gap-3 px-3 shrink-0">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="p-1.5 -ml-1 text-slate-600 hover:bg-slate-100 rounded"
          >
            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">WD</div>
            <span className="text-sm font-semibold text-slate-900">Product Tools</span>
          </div>
        </div>

        <main className="flex-1 min-h-0 flex flex-col overflow-hidden bg-slate-100">{children}</main>
      </div>
    </div>
  );
}
