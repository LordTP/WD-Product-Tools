"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  href: string;
  label: string;
  icon: (p: { className?: string }) => React.ReactElement;
  soon?: boolean;
  /** Indented sub-item of the entry above it. */
  sub?: boolean;
  /** Other paths that should light this entry up (e.g. a page reached from it). */
  also?: string[];
};
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
      { href: "/calendar", label: "Calendar", icon: CalendarIcon },
    ],
  },
  {
    group: "Tools",
    items: [
      // PO History is the Purchase Orders home; the upload flow stays at
      // /purchase-orders and is reached from its "Add PO" button.
      { href: "/history", label: "Purchase Orders", icon: PoIcon, also: ["/purchase-orders"] },
      // Hidden for now — Swap QC returns export not ready for the team yet.
      // { href: "/returns", label: "Returns", icon: ReturnIcon },
      { href: "/products", label: "Products → Shopify", icon: ProductIcon },
    ],
  },
  {
    group: "Warehouse",
    items: [
      { href: "/order-well", label: "Order Well", icon: OpsIcon },
      { href: "/operations", label: "Operations", icon: ActivityIcon },
      { href: "/returns", label: "Returns", icon: ReturnIcon },
      { href: "/returns-pick-faces", label: "Returns Pick Faces", icon: BinIcon },
      { href: "/cycle-counts", label: "Cycle Counts", icon: CountIcon },
      { href: "/po-unreceive", label: "PO Un-receive", icon: UndoIcon },
    ],
  },
  {
    group: "Data",
    items: [
      { href: "/vendors", label: "Vendors", icon: VendorIcon },
      { href: "/sizes", label: "Size Map", icon: SizeIcon },
    ],
  },
];

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const pathname = usePathname();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 w-56 shrink-0 bg-white border-r border-slate-200 flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="h-14 flex items-center gap-2.5 px-4 border-b border-slate-200">
        <div className="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center text-white text-[11px] font-bold">
          WD
        </div>
        <span className="text-sm font-semibold text-slate-900">Product Tools</span>
      </div>

      <nav className="flex-1 p-2 overflow-y-auto">
        {NAV.map((section) => (
          <div key={section.group}>
            <p className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-slate-400">
              {section.group}
            </p>
            {section.items.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + "/") ||
                (item.also ?? []).some((a) => pathname === a || pathname.startsWith(a + "/"));
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.soon ? "#" : item.href}
                  onClick={onNavigate}
                  aria-disabled={item.soon}
                  className={`flex items-center gap-2.5 py-2 rounded-md text-sm mb-0.5 transition-colors ${
                    item.sub ? "pl-8 pr-3" : "px-3"
                  } ${
                    active
                      ? "bg-indigo-50 text-indigo-700 font-medium"
                      : item.soon
                        ? "text-slate-300 cursor-default"
                        : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <Icon className={`${item.sub ? "w-3.5 h-3.5" : "w-4 h-4"} shrink-0`} />
                  <span className="truncate">{item.label}</span>
                  {item.soon && (
                    <span className="ml-auto text-[9px] uppercase tracking-wide text-slate-300">
                      soon
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-slate-200 flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center text-xs font-medium text-slate-600">
          WD
        </div>
        <div className="text-xs leading-tight min-w-0">
          <p className="text-slate-700 font-medium">Product team</p>
          <p className="font-brand text-[15px] text-slate-500 tracking-tight">Wander Doll</p>
        </div>
        <button
          onClick={logout}
          title="Sign out"
          className="ml-auto text-slate-400 hover:text-slate-700 p-1.5 rounded hover:bg-slate-100"
        >
          <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
        </button>
      </div>
    </aside>
  );
}

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}
function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}
function PoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </svg>
  );
}
function ProductIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M20 7 12 3 4 7v10l8 4 8-4z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </svg>
  );
}
function VendorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-3" />
    </svg>
  );
}
function SizeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M3 8v8M21 8v8M3 12h18M7 10v4M11 9v6M15 10v4M19 9v6" />
    </svg>
  );
}
function ReturnIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
    </svg>
  );
}
function BinIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 4v16M15 4v16" />
    </svg>
  );
}
function ActivityIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function OpsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M3 3v18h18" />
      <path d="M7 15l3-4 3 3 4-6" />
    </svg>
  );
}
function CountIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}
function UndoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
    </svg>
  );
}
