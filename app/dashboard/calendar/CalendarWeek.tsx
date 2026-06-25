"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, X, MapPin, Check, Ban } from "lucide-react";
import { saveMeetingNotes, setMeetingOutcome } from "./actions";

export type EventVM = {
  id: string;
  title: string;
  location: string | null;
  startISO: string;
  endISO: string | null;
  allDay: boolean;
  attendees: { email: string; name: string | null }[];
  held: boolean | null;
  notes: string | null;
  contactId: string | null;
  contactName: string | null;
};

const TZ = "America/New_York";
const START_HOUR = 6;
const END_HOUR = 23;
const HOUR_H = 48;
const GRID_H = (END_HOUR - START_HOUR) * HOUR_H;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function etParts(d: Date): { dayKey: string; minutes: number } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = f.formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  let hh = parseInt(g("hour"), 10);
  if (hh === 24) hh = 0;
  return { dayKey: `${g("year")}-${g("month")}-${g("day")}`, minutes: hh * 60 + parseInt(g("minute"), 10) };
}

function todayKeyET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

/** The 7 day-cells (Sun..Sat) for the week at `offset` weeks from today. */
function weekDays(offset: number): { key: string; label: string; dom: number; isToday: boolean }[] {
  const [y, m, d] = todayKeyET().split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12));
  const sunday = new Date(base.getTime() - base.getUTCDay() * 86_400_000 + offset * 7 * 86_400_000);
  const tk = todayKeyET();
  return Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(sunday.getTime() + i * 86_400_000);
    const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    return { key, label: DOW[dt.getUTCDay()], dom: dt.getUTCDate(), isToday: key === tk };
  });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}
function fmtRange(e: EventVM): string {
  if (e.allDay) return "All day";
  const s = fmtTime(e.startISO);
  return e.endISO ? `${s} – ${fmtTime(e.endISO)}` : s;
}

export function CalendarWeek({ events }: { events: EventVM[] }) {
  const [offset, setOffset] = useState(0);
  const [selId, setSelId] = useState<string | null>(null);
  const [heldOv, setHeldOv] = useState<Record<string, boolean>>({});
  const [notesOv, setNotesOv] = useState<Record<string, string>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const days = useMemo(() => weekDays(offset), [offset]);
  const dayKeys = useMemo(() => new Set(days.map((d) => d.key)), [days]);

  // Bucket events into the displayed week by ET day.
  const { timed, allday } = useMemo(() => {
    const timed: Record<string, EventVM[]> = {};
    const allday: Record<string, EventVM[]> = {};
    for (const e of events) {
      const { dayKey } = etParts(new Date(e.startISO));
      if (!dayKeys.has(dayKey)) continue;
      const bucket = e.allDay ? allday : timed;
      const arr = bucket[dayKey] ?? (bucket[dayKey] = []);
      arr.push(e);
    }
    return { timed, allday };
  }, [events, dayKeys]);

  const sel = useMemo(() => events.find((e) => e.id === selId) ?? null, [events, selId]);
  const heldOf = (e: EventVM): boolean | null => (e.id in heldOv ? heldOv[e.id] : e.held);
  const notesOf = (e: EventVM): string => (e.id in notesOv ? notesOv[e.id] : e.notes ?? "");

  const rangeLabel = (() => {
    const a = days[0];
    const b = days[6];
    const month = (k: string) =>
      new Date(k + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric" });
    return month(a.key) === month(b.key)
      ? month(a.key)
      : `${new Date(a.key + "T12:00:00Z").toLocaleDateString("en-US", { month: "short" })} – ${month(b.key)}`;
  })();

  const nowKey = todayKeyET();
  const nowMin = etParts(new Date()).minutes;

  async function onHeld(e: EventVM, held: boolean) {
    setHeldOv((s) => ({ ...s, [e.id]: held }));
    await setMeetingOutcome(e.id, held);
  }
  function onNotes(e: EventVM, v: string) {
    setNotesOv((s) => ({ ...s, [e.id]: v }));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveMeetingNotes(e.id, v), 700);
  }

  return (
    <div className="mt-3 flex gap-4">
      <div className="min-w-0 flex-1">
        {/* Toolbar */}
        <div className="mb-3 flex items-center gap-3">
          <button
            onClick={() => setOffset(0)}
            className="rounded-lg border border-hairline px-3 py-1.5 text-sm font-medium hover:bg-black/[0.03]"
          >
            Today
          </button>
          <div className="flex items-center">
            <button onClick={() => setOffset((o) => o - 1)} className="rounded-md p-1.5 hover:bg-black/[0.05]">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={() => setOffset((o) => o + 1)} className="rounded-md p-1.5 hover:bg-black/[0.05]">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <span className="text-lg font-semibold tracking-tight">{rangeLabel}</span>
        </div>

        <div className="overflow-hidden rounded-2xl border border-hairline bg-white">
          {/* Day headers */}
          <div className="grid border-b border-hairline" style={{ gridTemplateColumns: `56px repeat(7, 1fr)` }}>
            <div className="border-r border-hairline" />
            {days.map((d) => (
              <div key={d.key} className="border-r border-hairline px-2 py-2 text-center last:border-r-0">
                <div className="text-[11px] uppercase tracking-wide text-muted">{d.label}</div>
                <div
                  className={`mx-auto mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold ${
                    d.isToday ? "bg-[#2d6cf6] text-white" : "text-ink"
                  }`}
                >
                  {d.dom}
                </div>
              </div>
            ))}
          </div>

          {/* All-day row */}
          <div
            className="grid border-b border-hairline bg-black/[0.015]"
            style={{ gridTemplateColumns: `56px repeat(7, 1fr)` }}
          >
            <div className="border-r border-hairline px-1 py-1 text-right text-[10px] text-muted">all-day</div>
            {days.map((d) => (
              <div key={d.key} className="min-h-[28px] space-y-0.5 border-r border-hairline p-1 last:border-r-0">
                {(allday[d.key] ?? []).map((e) => (
                  <button
                    key={e.id}
                    onClick={() => setSelId(e.id)}
                    className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] ${
                      e.contactId ? "bg-indigo-100 text-indigo-700" : "bg-black/[0.06] text-ink/70"
                    }`}
                  >
                    {e.title}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Timed grid */}
          <div className="max-h-[640px] overflow-y-auto">
            <div className="grid" style={{ gridTemplateColumns: `56px repeat(7, 1fr)` }}>
              {/* Hour gutter */}
              <div className="relative" style={{ height: GRID_H }}>
                {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
                  <div
                    key={i}
                    className="absolute right-1 -translate-y-1/2 text-[10px] text-muted"
                    style={{ top: i * HOUR_H }}
                  >
                    {((START_HOUR + i + 11) % 12) + 1}
                    {START_HOUR + i < 12 ? "am" : "pm"}
                  </div>
                ))}
              </div>
              {/* Day columns */}
              {days.map((d) => (
                <div key={d.key} className="relative border-l border-hairline" style={{ height: GRID_H }}>
                  {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
                    <div key={i} className="absolute left-0 right-0 border-b border-hairline/60" style={{ top: (i + 1) * HOUR_H }} />
                  ))}
                  {d.key === nowKey && nowMin >= START_HOUR * 60 && nowMin <= END_HOUR * 60 && (
                    <div
                      className="absolute left-0 right-0 z-10 border-t-2 border-rose-500"
                      style={{ top: ((nowMin - START_HOUR * 60) / 60) * HOUR_H }}
                    >
                      <div className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-rose-500" />
                    </div>
                  )}
                  {(timed[d.key] ?? []).map((e) => {
                    const sm = etParts(new Date(e.startISO)).minutes;
                    const durMin = e.endISO
                      ? Math.max(20, (new Date(e.endISO).getTime() - new Date(e.startISO).getTime()) / 60000)
                      : 50;
                    const top = Math.max(0, ((sm - START_HOUR * 60) / 60) * HOUR_H);
                    const height = Math.min(GRID_H - top, Math.max(20, (durMin / 60) * HOUR_H));
                    const people = !!e.contactId;
                    const held = heldOf(e);
                    return (
                      <button
                        key={e.id}
                        onClick={() => setSelId(e.id)}
                        className={`absolute left-0.5 right-0.5 overflow-hidden rounded-md border px-1.5 py-1 text-left ${
                          people
                            ? "border-indigo-200 bg-indigo-50 hover:bg-indigo-100"
                            : "border-hairline bg-white hover:bg-black/[0.03]"
                        } ${selId === e.id ? "ring-2 ring-[#2d6cf6]" : ""}`}
                        style={{ top, height }}
                      >
                        <div className="flex items-center gap-1">
                          {held === true && <Check className="h-3 w-3 shrink-0 text-emerald-600" />}
                          {held === false && <Ban className="h-3 w-3 shrink-0 text-rose-500" />}
                          <span className={`truncate text-[11px] font-medium ${people ? "text-indigo-800" : "text-ink"}`}>
                            {e.title}
                          </span>
                        </div>
                        {height > 30 && <div className="truncate text-[10px] text-muted">{fmtTime(e.startISO)}</div>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Detail panel */}
      {sel && (
        <div className="w-80 shrink-0 self-start rounded-2xl border border-hairline bg-white p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-base font-semibold leading-snug text-ink">{sel.title}</h3>
            <button onClick={() => setSelId(null)} className="rounded p-1 text-muted hover:bg-black/[0.05]">
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-1 text-sm text-muted">{fmtRange(sel)}</p>
          {sel.location && (
            <p className="mt-1 flex items-center gap-1 text-xs text-muted">
              <MapPin className="h-3 w-3" /> {sel.location}
            </p>
          )}
          {sel.contactId ? (
            <Link href={`/dashboard/contacts/${sel.contactId}`} className="mt-2 inline-block text-sm text-[#2d6cf6] hover:underline">
              {sel.contactName ?? "View contact"} →
            </Link>
          ) : sel.attendees.length > 0 ? (
            <p className="mt-2 text-xs text-muted">With: {sel.attendees.map((a) => a.name || a.email).slice(0, 4).join(", ")}</p>
          ) : null}

          {/* Did it hold? */}
          {new Date(sel.startISO).getTime() <= Date.now() ? (
            <div className="mt-4 rounded-xl border border-hairline p-3">
              <div className="text-xs font-medium text-ink">Did this meeting hold?</div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => onHeld(sel, true)}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-sm font-medium ${
                    heldOf(sel) === true ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-hairline hover:bg-black/[0.03]"
                  }`}
                >
                  <Check className="h-3.5 w-3.5" /> Yes
                </button>
                <button
                  onClick={() => onHeld(sel, false)}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-sm font-medium ${
                    heldOf(sel) === false ? "border-rose-300 bg-rose-50 text-rose-600" : "border-hairline hover:bg-black/[0.03]"
                  }`}
                >
                  <Ban className="h-3.5 w-3.5" /> No-show
                </button>
              </div>
              {heldOf(sel) == null && <p className="mt-1.5 text-[11px] text-amber-600">Pending confirmation</p>}
            </div>
          ) : (
            <p className="mt-4 text-xs text-muted">Confirmation opens once the meeting starts.</p>
          )}

          {/* Notes */}
          <div className="mt-3">
            <div className="text-xs font-medium text-ink">Notes</div>
            <textarea
              value={notesOf(sel)}
              onChange={(e) => onNotes(sel, e.target.value)}
              placeholder="Type notes during the meeting — they autosave to the contact's profile…"
              rows={7}
              className="mt-1.5 w-full resize-y rounded-lg border border-hairline bg-white px-3 py-2 text-sm outline-none focus:border-black/30"
            />
            <p className="mt-1 text-[11px] text-muted">Saves automatically.</p>
          </div>
        </div>
      )}
    </div>
  );
}
