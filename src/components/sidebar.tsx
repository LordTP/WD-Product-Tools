"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; icon: (p: { className?: string }) => React.ReactElement; soon?: boolean };
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: DashboardIcon }],
  },
  {
    group: "Tools",
    items: [
      { href: "/purchase-orders", label: "Purchase Orders", icon: PoIcon },
      { href: "/products", label: "Products → Shopify", icon: ProductIcon },
    ],
  },
  {
    group: "Data",
    items: [
      { href: "/vendors", label: "Vendors", icon: VendorIcon },
      { href: "/history", label: "PO History", icon: HistoryIcon },
      { href: "/sizes", label: "Size Map", icon: SizeIcon },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-56 shrink-0 bg-white border-r border-slate-200 flex flex-col">
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
                pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.soon ? "#" : item.href}
                  aria-disabled={item.soon}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm mb-0.5 transition-colors ${
                    active
                      ? "bg-indigo-50 text-indigo-700 font-medium"
                      : item.soon
                        ? "text-slate-300 cursor-default"
                        : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
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
        <div className="text-xs leading-tight">
          <p className="text-slate-700 font-medium">Product team</p>
          <p className="text-slate-400">Wander Doll</p>
        </div>
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
function HistoryIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8M12 7v5l4 2" />
    </svg>
  );
}
