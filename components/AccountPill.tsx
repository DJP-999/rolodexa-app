"use client";

import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";

/**
 * The "Dominick" account pill — top-right of the panel. In the original it
 * appears on the home dashboard only, so it's hidden on the inner pages
 * (where it would collide with page actions like "Generate").
 */
export function AccountPill() {
  const path = usePathname();
  if (path !== "/dashboard") return null;
  return (
    <div className="absolute right-5 top-5 z-10">
      <button className="flex items-center gap-2 rounded-full bg-black py-1.5 pl-3 pr-1.5 text-sm font-medium text-white">
        <ChevronDown className="h-4 w-4 opacity-60" />
        Dominick
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-[11px] font-bold text-white">
          DP
        </span>
      </button>
    </div>
  );
}
