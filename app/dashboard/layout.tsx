import Link from "next/link";
import type { ReactNode } from "react";

const NAV = [
  ["Home", "/dashboard"],
  ["Contacts", "/dashboard/contacts"],
  ["Projects", "/dashboard/projects"],
  ["Suggestions", "/dashboard/suggestions"],
  ["Automations", "/dashboard/automations"],
  ["Settings", "/dashboard/settings"],
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-64 shrink-0 border-r border-hairline bg-canvas px-3 py-5">
        <div className="flex items-center gap-2 px-3 pb-6">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink text-xs font-bold text-white">
            R
          </div>
          <span className="font-semibold">Rolodexa</span>
        </div>
        <nav className="space-y-1">
          {NAV.map(([label, href]) => (
            <Link key={href} href={href} className="navlink">
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-6 border-t border-hairline px-3 pt-4 text-xs uppercase tracking-wide text-muted">
          Chats
        </div>
        <div className="navlink mt-1">
          iMessage <span className="chip ml-auto">PHONE</span>
        </div>
      </aside>
      <main className="flex-1 bg-surface/40 p-8">{children}</main>
    </div>
  );
}
