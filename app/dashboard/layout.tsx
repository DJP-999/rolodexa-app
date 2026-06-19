import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import { AccountPill } from "@/components/AccountPill";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#ececee] p-2">
      <Sidebar />
      <main className="dotted-bg relative flex-1 overflow-hidden rounded-panel bg-white shadow-sm ring-1 ring-black/[0.04]">
        <AccountPill />
        <div className="h-[calc(100vh-1rem)] overflow-y-auto px-10 py-9">{children}</div>
      </main>
    </div>
  );
}
