"use client";

import { useRef } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search, SlidersHorizontal } from "lucide-react";

const CATS = ["Coworker", "Friend", "Investor", "Other", "Vendor"];

export function ContactsFilters({
  enriched,
  vip = 0,
  promoted = 0,
}: {
  enriched: number;
  vip?: number;
  promoted?: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const q = params.get("q") ?? "";
  const rel = params.get("rel") ?? "";
  const tab = params.get("tab") ?? "";

  const update = (k: string, v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const pill = (active: boolean) =>
    active
      ? "rounded-full bg-black px-3 py-1 font-medium text-white"
      : "cursor-pointer rounded-full px-3 py-1 text-muted hover:text-ink";

  return (
    <>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <div className="flex w-[340px] items-center gap-2 rounded-xl border border-hairline bg-white px-3 py-2.5">
          <Search className="h-4 w-4 text-muted" />
          <input
            defaultValue={q}
            placeholder="Search contacts..."
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
            onChange={(e) => {
              const v = e.target.value;
              clearTimeout(timer.current);
              timer.current = setTimeout(() => update("q", v), 300);
            }}
          />
        </div>
        <SlidersHorizontal className="h-4 w-4 text-muted" />
        <div className="flex items-center gap-1 text-sm">
          <span className={pill(!rel)} onClick={() => update("rel", "")}>
            All
          </span>
          {CATS.map((c) => (
            <span
              key={c}
              className={pill(rel === c.toLowerCase())}
              onClick={() => update("rel", c.toLowerCase())}
            >
              {c}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-1 text-sm">
        <span className={pill(!tab)} onClick={() => update("tab", "")}>
          All
        </span>
        <span
          className={`flex items-center gap-1.5 ${pill(tab === "enriched")}`}
          onClick={() => update("tab", "enriched")}
        >
          Enriched <span className="chip">{enriched}</span>
        </span>
        <span className={pill(tab === "new")} onClick={() => update("tab", "new")} title="Added in the last 7 days">
          New
        </span>
        <span
          className={`flex items-center gap-1.5 ${pill(tab === "promoted")}`}
          onClick={() => update("tab", "promoted")}
          title="Graduated from cold outreach in the last 7 days"
        >
          Promoted {promoted > 0 && <span className="chip">{promoted}</span>}
        </span>
        <span className={pill(tab === "recent")} onClick={() => update("tab", "recent")} title="Interacted with in the last 7 days">
          Recent
        </span>
        <span className={pill(tab === "needs")} onClick={() => update("tab", "needs")}>
          Needs Context
        </span>
        <span
          className={`flex items-center gap-1.5 ${pill(tab === "vip")}`}
          onClick={() => update("tab", "vip")}
          title="Your high-value VIP contacts"
        >
          ⭐ VIP {vip > 0 && <span className="chip">{vip}</span>}
        </span>
      </div>
    </>
  );
}
