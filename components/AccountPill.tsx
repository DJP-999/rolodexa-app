"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronDown, Settings, LogOut } from "lucide-react";

/**
 * The "Dominick" account pill — top-right of the panel, home only. Mimics the
 * original's black chevron pill, but actually opens an account menu.
 */
export function AccountPill({ name = "Dominick Pandolfo" }: { name?: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (path !== "/dashboard") return null;

  const first = name.split(/\s+/)[0] || "Account";
  const initials =
    name
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "DP";

  return (
    <div ref={ref} className="absolute right-5 top-5 z-20">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full bg-black py-1.5 pl-3 pr-1.5 text-sm font-medium text-white"
      >
        <ChevronDown
          className={`h-4 w-4 opacity-60 transition-transform ${open ? "rotate-180" : ""}`}
        />
        {first}
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-[11px] font-bold text-white">
          {initials}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 overflow-hidden rounded-2xl border border-hairline bg-white shadow-xl">
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-xs font-bold text-white">
              {initials}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-ink">{name}</div>
              <div className="truncate text-xs text-muted">Personal workspace</div>
            </div>
          </div>
          <div className="h-px bg-hairline" />
          <Link
            href="/dashboard/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-ink hover:bg-black/[0.03]"
          >
            <Settings className="h-4 w-4 text-muted" /> Settings
          </Link>
          <button
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink hover:bg-black/[0.03]"
          >
            <LogOut className="h-4 w-4 text-muted" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
