"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Plus, X, MapPin } from "lucide-react";

export type MapContact = {
  id: string;
  name: string;
  role: string | null;
  company: string | null;
  relationship: string;
  fit: number | null;
  highValue: boolean;
  lat: number;
  lng: number;
  city: string;
  inferred: boolean;
};

const REL_COLOR: Record<string, string> = {
  investor: "#8b5cf6",
  friend: "#f43f5e",
  coworker: "#0ea5e9",
  vendor: "#f59e0b",
  family: "#10b981",
  other: "#9ca3af",
};

function loadCss(href: string, id: string) {
  if (document.getElementById(id)) return;
  const l = document.createElement("link");
  l.id = id;
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}
function loadScript(src: string, id: string): Promise<void> {
  return new Promise((resolve) => {
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded) resolve();
      else existing.addEventListener("load", () => resolve());
      return;
    }
    const s = document.createElement("script");
    s.id = id;
    s.src = src;
    s.async = true;
    s.addEventListener("load", () => {
      s.dataset.loaded = "1";
      resolve();
    });
    document.body.appendChild(s);
  });
}

async function ensureLeaflet(): Promise<any> {
  const L = () => (window as any).L;
  loadCss("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css", "leaflet-css");
  loadCss("https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.min.css", "mc-css");
  loadCss("https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.min.css", "mc-css2");
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js", "leaflet-js");
  if (!L()?.markerClusterGroup)
    await loadScript(
      "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.min.js",
      "mc-js",
    );
  return L();
}

export function MapView({ contacts, unmapped }: { contacts: MapContact[]; unmapped: number }) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const clusterRef = useRef<any>(null);
  const [ready, setReady] = useState(false);

  const [rel, setRel] = useState("");
  const [minFit, setMinFit] = useState(0);
  const [highOnly, setHighOnly] = useState(false);
  const [q, setQ] = useState("");
  const [selectedCity, setSelectedCity] = useState<string | null>(null);
  const [trip, setTrip] = useState<string[]>([]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return contacts.filter((c) => {
      if (rel && c.relationship !== rel) return false;
      if (highOnly && !c.highValue) return false;
      if (minFit > 0 && (c.fit == null || c.fit * 100 < minFit)) return false;
      if (needle) {
        const hay = `${c.name} ${c.company ?? ""} ${c.city}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [contacts, rel, minFit, highOnly, q]);

  // Cities aggregated from the filtered set, with a center for fly-to.
  const cities = useMemo(() => {
    const m = new Map<string, { count: number; lat: number; lng: number; list: MapContact[] }>();
    for (const c of filtered) {
      const e = m.get(c.city) ?? { count: 0, lat: 0, lng: 0, list: [] };
      e.count++;
      e.lat += c.lat;
      e.lng += c.lng;
      e.list.push(c);
      m.set(c.city, e);
    }
    return [...m.entries()]
      .map(([city, e]) => ({ city, count: e.count, lat: e.lat / e.count, lng: e.lng / e.count, list: e.list }))
      .sort((a, b) => b.count - a.count);
  }, [filtered]);

  // Init map once.
  useEffect(() => {
    let cancelled = false;
    ensureLeaflet().then((L) => {
      if (cancelled || !mapDiv.current || mapRef.current) return;
      const map = L.map(mapDiv.current, { worldCopyJump: true }).setView([39.5, -98.35], 4);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
        maxZoom: 18,
      }).addTo(map);
      const cluster = L.markerClusterGroup({ maxClusterRadius: 45 });
      map.addLayer(cluster);
      mapRef.current = map;
      clusterRef.current = cluster;
      setReady(true);
    });
    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Rebuild markers when the filtered set changes.
  useEffect(() => {
    if (!ready || !clusterRef.current) return;
    const L = (window as any).L;
    const cluster = clusterRef.current;
    cluster.clearLayers();
    for (const c of filtered) {
      const color = REL_COLOR[c.relationship] ?? REL_COLOR.other;
      const icon = L.divIcon({
        className: "",
        html: `<span style="display:block;width:14px;height:14px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25)"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      const fitTxt = c.fit != null ? ` · fit ${Math.round(c.fit * 100)}` : "";
      const m = L.marker([c.lat, c.lng], { icon });
      m.bindPopup(
        `<strong>${c.name}${c.highValue ? " 🔥" : ""}</strong><br>${
          [c.role, c.company].filter(Boolean).join(" · ") || ""
        }<br><span style="color:#6b7280">${c.city}${c.inferred ? " (firm HQ)" : ""}${fitTxt}</span>`,
      );
      cluster.addLayer(m);
    }
  }, [filtered, ready]);

  const flyTo = (lat: number, lng: number, city: string) => {
    setSelectedCity(city);
    if (mapRef.current) mapRef.current.flyTo([lat, lng], 9, { duration: 0.8 });
  };

  const inTrip = (id: string) => trip.includes(id);
  const toggleTrip = (id: string) => setTrip((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const tripContacts = contacts.filter((c) => trip.includes(c.id));
  const selected = cities.find((c) => c.city === selectedCity) ?? null;

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Map + filters */}
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, company, city…"
            className="w-56 rounded-lg border border-hairline bg-white px-3 py-1.5 text-sm"
          />
          <select value={rel} onChange={(e) => setRel(e.target.value)} className="rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs text-ink">
            <option value="">All relationships</option>
            {["investor", "friend", "coworker", "vendor", "family", "other"].map((r) => (
              <option key={r} value={r} className="capitalize">{r}</option>
            ))}
          </select>
          <select value={minFit} onChange={(e) => setMinFit(Number(e.target.value))} className="rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs text-ink">
            <option value={0}>Any fit</option>
            <option value={55}>Fit ≥ 55</option>
            <option value={70}>Fit ≥ 70</option>
            <option value={85}>Fit ≥ 85</option>
          </select>
          <button
            onClick={() => setHighOnly((v) => !v)}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium ${highOnly ? "border-amber-300 bg-amber-50 text-amber-700" : "border-hairline text-muted hover:bg-black/[0.03]"}`}
          >
            🔥 High-value
          </button>
          <span className="text-xs text-muted">{filtered.length} shown</span>
        </div>
        <div ref={mapDiv} className="h-[640px] w-full overflow-hidden rounded-2xl border border-hairline bg-[#e8eef3]" />
        <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
          {Object.entries(REL_COLOR).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1 capitalize">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: v }} /> {k}
            </span>
          ))}
        </div>
      </div>

      {/* Side panel */}
      <div className="w-full shrink-0 space-y-4 lg:w-96">
        {/* Trip */}
        <div className="rounded-2xl border border-hairline bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Road-show trip</h3>
            {trip.length > 0 && (
              <button onClick={() => setTrip([])} className="text-xs text-muted hover:text-ink">Clear</button>
            )}
          </div>
          {tripContacts.length === 0 ? (
            <p className="mt-1.5 text-xs text-muted">Add people from a city below to build a visit list.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {tripContacts.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">
                    {c.name} <span className="text-muted">· {c.city}</span>
                  </span>
                  <button onClick={() => toggleTrip(c.id)} className="shrink-0 text-muted hover:text-rose-500">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* City list or selected-city contacts */}
        <div className="rounded-2xl border border-hairline bg-white p-4">
          {!selected ? (
            <>
              <h3 className="text-sm font-semibold text-ink">Cities</h3>
              <ul className="mt-2 max-h-[420px] space-y-1 overflow-y-auto">
                {cities.map((c) => (
                  <li key={c.city}>
                    <button
                      onClick={() => flyTo(c.lat, c.lng, c.city)}
                      className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm hover:bg-black/[0.03]"
                    >
                      <span className="flex items-center gap-1.5 truncate text-ink">
                        <MapPin className="h-3.5 w-3.5 text-muted" /> {c.city}
                      </span>
                      <span className="shrink-0 rounded-full bg-black/[0.06] px-2 text-xs text-muted">{c.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink">{selected.city}</h3>
                <button onClick={() => setSelectedCity(null)} className="text-xs text-muted hover:text-ink">← All cities</button>
              </div>
              <p className="mt-0.5 text-xs text-muted">{selected.count} contacts here</p>
              <ul className="mt-2 max-h-[420px] space-y-2 overflow-y-auto">
                {selected.list.map((c) => (
                  <li key={c.id} className="flex items-start justify-between gap-2 rounded-lg border border-hairline p-2">
                    <div className="min-w-0">
                      <Link href={`/dashboard/contacts/${c.id}`} className="text-sm font-medium text-ink hover:underline">
                        {c.name}{c.highValue ? " 🔥" : ""}
                      </Link>
                      <div className="truncate text-xs text-muted">
                        {[c.role, c.company].filter(Boolean).join(" · ") || "—"}
                        {c.fit != null ? ` · fit ${Math.round(c.fit * 100)}` : ""}
                        {c.inferred ? " · firm HQ" : ""}
                      </div>
                    </div>
                    <button
                      onClick={() => toggleTrip(c.id)}
                      title={inTrip(c.id) ? "Remove from trip" : "Add to trip"}
                      className={`shrink-0 rounded-md border px-1.5 py-1 ${inTrip(c.id) ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-hairline text-muted hover:bg-black/[0.03]"}`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        {unmapped > 0 && (
          <p className="px-1 text-xs text-muted">{unmapped} contacts couldn&apos;t be placed (no recognizable location).</p>
        )}
      </div>
    </div>
  );
}
