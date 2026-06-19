import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#ececee] p-2">
      <Sidebar />
      <main className="dotted-bg relative flex-1 overflow-hidden rounded-panel bg-white shadow-sm ring-1 ring-black/[0.04]">
        <div className="absolute right-5 top-5 z-10">
          <button className="flex items-center gap-2 rounded-full bg-black py-1.5 pl-3 pr-1.5 text-sm font-medium text-white">
            <ChevronDown className="h-4 w-4 opacity-60" />
            Dominick
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-[11px] font-bold text-white">
              DP
            </span>
          </button>
        </div>
        <div className="h-[calc(100vh-1rem)] overflow-y-auto px-10 py-9">{children}</div>
      </main>
    </div>
  );
}
