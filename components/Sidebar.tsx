"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Users,
  Briefcase,
  Bell,
  AlarmClock,
  Settings,
  Smartphone,
  MessageSquarePlus,
  Database,
  BarChart3,
  Snowflake,
  Calendar,
} from "lucide-react";

const NAV = [
  { label: "Home", href: "/dashboard", Icon: Home },
  { label: "Contacts", href: "/dashboard/contacts", Icon: Users },
  { label: "PitchBook", href: "/dashboard/pitchbook", Icon: Database },
  { label: "Calendar", href: "/dashboard/calendar", Icon: Calendar },
  { label: "KPI Tracking", href: "/dashboard/kpi", Icon: BarChart3 },
  { label: "Cold Outreach", href: "/dashboard/cold-outreach", Icon: Snowflake },
  { label: "Projects", href: "/dashboard/projects", Icon: Briefcase },
  { label: "Suggestions", href: "/dashboard/suggestions", Icon: Bell },
  { label: "Automations", href: "/dashboard/automations", Icon: AlarmClock },
  { label: "Settings", href: "/dashboard/settings", Icon: Settings },
];

export function Sidebar() {
  const path = usePathname();
  return (
    <aside className="flex w-64 shrink-0 flex-col px-3 py-5">
      <div className="flex items-center gap-2.5 px-2 pb-7">
        <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-ink text-sm font-bold text-white">
          R
        </div>
        <span className="text-[17px] font-bold tracking-tight">Rolodexa</span>
      </div>

      <nav className="space-y-1">
        {NAV.map(({ label, href, Icon }) => {
          const active = href === "/dashboard" ? path === href : path.startsWith(href);
          return (
            <Link key={href} href={href} className={`navlink ${active ? "navlink-active" : ""}`}>
              <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mb-1 mt-7 flex items-center justify-between px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Chats</span>
        <MessageSquarePlus className="h-4 w-4 text-muted" strokeWidth={1.75} />
      </div>
      <div className="navlink">
        <Smartphone className="h-[18px] w-[18px]" strokeWidth={1.75} />
        iMessage
        <span className="chip ml-auto">PHONE</span>
      </div>

      <div className="mt-auto flex items-center gap-2.5 px-2 pt-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-black/[0.06] text-[11px] font-semibold text-muted">
          DP
        </div>
        <span className="text-sm font-medium">Dominick Pandolfo</span>
      </div>
    </aside>
  );
}
