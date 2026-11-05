import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import L from "./leaflet-global";
import "@geoman-io/leaflet-geoman-free";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, ImageOverlay, MapContainer, Pane, Polygon as LPolygon, TileLayer, useMap } from "react-leaflet";
import { circlePolygon } from "@/compute/derive";
import { intensityColor, rampGradient } from "@/data/ramp";
import { cellsQuery, hotspotsQuery } from "@/data/queries";
import { addMonths, parseYm, type CellsResult, type Polygon } from "@/data/types";
import { digits, monthYear, num, t, tf } from "@/i18n";
import { useApp } from "@/state/app";
import { useSettings } from "@/state/settings";
import { cn } from "@/lib/utils";
import { RiskLayer, RiskLegend, RiskToggle } from "@/ml/RiskLayer";

const GIBS =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg";
// Free, keyless Esri tile services: light/dark canvas for streets, reference labels for both.
const ESRI = (service: string) => `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`;
const ESRI_ATTR = 'Basemap &amp; labels &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function FitArea({ bbox }: { bbox: [number, number, number, number] | null }) {
  const map = useMap();
  const key = bbox?.join(",");
  useEffect(() => {
    if (bbox) map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { padding: [24, 24], maxZoom: 10 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

/** Geoman draw tools: rectangle, polygon, and circle used as "pin + radius". */
function DrawTools({ onArea, lang }: { onArea(p: Polygon): void; lang: string }) {
  const map = useMap();
  const cb = useRef(onArea);
  cb.current = onArea;
  useEffect(() => {
    map.pm.setLang(lang === "es" ? "es" : "en");
    map.pm.addControls({
      position: "topleft",
      drawMarker: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawText: false,
      drawRectangle: true,
      drawPolygon: true,
      drawCircle: true,
      editMode: false,
      dragMode: false,
      cutPolygon: false,
      removalMode: false,
      rotateMode: false,
    });
    // Geoman's toolbar links have no accessible name; give each the tool's title.
    map.getContainer().querySelectorAll<HTMLElement>(".leaflet-pm-toolbar .button-container").forEach((c) => {
      const a = c.querySelector("a");
      const name = c.getAttribute("title") ?? a?.getAttribute("title");
      if (a && name) a.setAttribute("aria-label", name);
    });
    const onCreate = (e: { layer: L.Layer; shape: string }) => {
      const layer = e.layer;
      let poly: Polygon | null = null;
      if (layer instanceof L.Circle) {
        const c = layer.getLatLng();
        poly = circlePolygon(c.lng, c.lat, Math.max(1, layer.getRadius() / 1000));
      } else if (layer instanceof L.Polygon) {
        const ring = (layer.getLatLngs()[0] ?? []) as L.LatLng[];
        poly = ring.map((ll) => [Math.round(ll.lng * 1000) / 1000, Math.round(ll.lat * 1000) / 1000] as [number, number]);
      }
      map.removeLayer(layer);
      if (poly && poly.length >= 3) cb.current(poly);
    };
    map.on("pm:create", onCreate as unknown as L.LeafletEventHandlerFn);
    return () => {
      map.off("pm:create", onCreate as unknown as L.LeafletEventHandlerFn);
      map.pm.removeControls();
    };
  }, [map, lang]);
  return null;
}

function TileErrors({ onError }: { onError(): void }) {
  const map = useMap();
  useEffect(() => {
    const h = () => onError();
    map.on("tileerror", h);
    return () => {
      map.off("tileerror", h);
    };
  }, [map, onError]);
  return null;
}

/** Density layer: harmonized activity per grid cell, summed over the selected range. */
function useDensity(cells: CellsResult | undefined, from: string, to: string, ramp: "inferno" | "cividis", dark: boolean) {
  return useMemo(() => {
    if (!cells || cells.cells.length === 0) return null;
    const i0 = Math.max(0, cells.months.indexOf(from));
    let i1 = cells.months.indexOf(to);
    if (i1 < 0) i1 = cells.months.length - 1;
    const d = cells.cell_deg;
    const lats = cells.cells.map((c) => c.lat);
    const lons = cells.cells.map((c) => c.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    // Draw in Web-Mercator space so the image matches the map's projection.
    const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const x0 = (minLon - d / 2) * (Math.PI / 180);
    const x1 = (maxLon + d / 2) * (Math.PI / 180);
    const yTop = mercY(maxLat + d / 2);
    const yBot = mercY(minLat - d / 2);
    const w = Math.min(1200, Math.max(1, Math.round(((maxLon - minLon) / d + 1) * 3)));
    const h = Math.max(1, Math.round((w * (yTop - yBot)) / (x1 - x0)));
    const px = (lon: number) => (((lon * Math.PI) / 180 - x0) / (x1 - x0)) * w;
    const py = (lat: number) => ((yTop - mercY(lat)) / (yTop - yBot)) * h;
    const sums = cells.cells.map((c) => {
      let s = 0;
      for (let k = i0; k <= i1; k++) s += c.v[k]!;
      return s;
    });
    const max = Math.max(1e-9, ...sums);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return null;
    cells.cells.forEach((c, i) => {
      const s = sums[i]!;
      if (s <= max * 0.01) return;
      g.globalAlpha = 0.35 + 0.55 * Math.sqrt(s / max);
      g.fillStyle = intensityColor(Math.sqrt(s / max), ramp, true);
      const left = px(c.lon - d / 2);
      const top = py(c.lat + d / 2);
      g.fillRect(left, top, Math.max(1, px(c.lon + d / 2) - left), Math.max(1, py(c.lat - d / 2) - top));
    });
    void dark;
    return {
      url: canvas.toDataURL(),
      bounds: L.latLngBounds([minLat - d / 2, minLon - d / 2], [maxLat + d / 2, maxLon + d / 2]),
      max,
    };
  }, [cells, from, to, ramp, dark]);
}

export default function MapPanel() {
  const { lang, url, setUrl, area, from, to, index, req, provOpts } = useApp();
  const { ramp, dark } = useSettings();
  const [tilesFailed, setTilesFailed] = useState(0);
  const cellsQ = useQuery(cellsQuery(url.src, provOpts, area?.bbox ?? null));
  const density = useDensity(cellsQ.data, from, to, ramp, dark);
  const mYear = url.m ? parseYm(url.m).y : null;
  const hq = useQuery(hotspotsQuery(url.src, provOpts, url.m ? req : null, mYear));
  const monthHotspots = useMemo(() => (url.m ? (hq.data?.rows ?? []).filter((r) => r.acq_datetime_utc.startsWith(url.m!)) : []), [hq.data, url.m]);

  const lastComplete = index ? addMonths(index.last_month, -1) : "2026-10";
  const gdate = url.gdate ?? `${url.m ?? lastComplete}-15`;
  const presets = index?.presets ?? [];
  const onArea = (poly: Polygon) => setUrl({ poly, area: "custom", m: null });

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="relative min-h-[18rem] flex-1 overflow-hidden rounded-lg border" role="region" aria-label={t(lang, "map.label")}>
        <MapContainer center={[23.5, 90]} zoom={6} className="h-full w-full" preferCanvas worldCopyJump attributionControl>
          {url.base === "sat" ? (
            <>
              <TileLayer key={gdate} url={GIBS.replace("{date}", gdate)} maxNativeZoom={9} maxZoom={13} attribution='Imagery: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>' />
              <TileLayer url={ESRI("Reference/World_Boundaries_and_Places")} attribution={ESRI_ATTR} maxNativeZoom={13} />
            </>
          ) : (
            <>
              <TileLayer key={dark ? "d" : "l"} url={ESRI(dark ? "Canvas/World_Dark_Gray_Base" : "Canvas/World_Light_Gray_Base")} attribution={ESRI_ATTR} maxNativeZoom={16} />
              <TileLayer key={dark ? "dr" : "lr"} url={ESRI(dark ? "Canvas/World_Dark_Gray_Reference" : "Canvas/World_Light_Gray_Reference")} maxNativeZoom={16} />
            </>
          )}
          <TileErrors onError={() => setTilesFailed((n) => n + 1)} />
          <FitArea bbox={area?.bbox ?? null} />
          <DrawTools onArea={onArea} lang={lang} />
          <Pane name="density" style={{ zIndex: 420 }}>
            {density && <ImageOverlay url={density.url} bounds={density.bounds} className="[image-rendering:pixelated]" />}
          </Pane>
          {presets
            .filter((p) => p.id !== area?.id)
            .map((p) => (
              <LPolygon
                key={p.id}
                positions={[
                  [p.bbox[1], p.bbox[0]],
                  [p.bbox[1], p.bbox[2]],
                  [p.bbox[3], p.bbox[2]],
                  [p.bbox[3], p.bbox[0]],
                ]}
                pathOptions={{ color: dark ? "#cbd5e1" : "#475569", weight: 1, dashArray: "4 4", fillOpacity: 0.04 }}
                eventHandlers={{ click: () => setUrl({ area: p.id, poly: null, m: null }) }}
              />
            ))}
          {area && <LPolygon positions={area.polygon.map(([lon, lat]) => [lat, lon] as [number, number])} pathOptions={{ color: "#f26b1d", weight: 3, fillOpacity: 0 }} />}
          <RiskLayer />
          <Pane name="hot" style={{ zIndex: 450 }}>
            {monthHotspots.slice(0, 2500).map((h, i) => (
              <CircleMarker key={i} center={[h.latitude, h.longitude]} radius={3.5} pathOptions={{ color: "#fff", weight: 0.8, fillColor: "#f26b1d", fillOpacity: 0.95 }} />
            ))}
          </Pane>
        </MapContainer>

        {tilesFailed > 4 && (
          <p className="absolute right-2 bottom-8 left-2 z-[1000] rounded-md bg-card/95 p-2 text-xs shadow" role="status">
            {t(lang, "map.tiles_off")}
          </p>
        )}
      </div>

      {/* Map controls below the map (keyboard friendly) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <fieldset className="seg" aria-label={t(lang, "map.layers")}>
          <legend className="sr-only">{t(lang, "map.layers")}</legend>
          {(["sat", "street"] as const).map((b) => (
            <button key={b} type="button" aria-pressed={url.base === b} onClick={() => setUrl({ base: b })}>
              {b === "sat" ? t(lang, "map.sat") : t(lang, "map.street")}
            </button>
          ))}
        </fieldset>
        <RiskToggle />
        {url.base === "sat" && (
          <label className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground">{t(lang, "map.date")}</span>
            <input type="date" className="field min-h-11 text-xs" value={gdate} max={new Date().toISOString().slice(0, 10)} min="2000-02-24" onChange={(e) => e.target.value && setUrl({ gdate: e.target.value })} />
          </label>
        )}
      </div>
      {density && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="h-2 w-28 rounded-full" style={{ background: rampGradient(ramp, true) }} aria-hidden="true" />
          <span>
            {tf(lang, "map.density", { from: monthYear(lang, from, true), to: monthYear(lang, to, true) })} · max {num(lang, density.max)}
          </span>
          {url.m && monthHotspots.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="size-2.5 rounded-full bg-[#f26b1d]" aria-hidden="true" />
              {capMonth(lang, url.m)}: {num(lang, monthHotspots.length)}
            </span>
          )}
        </div>
      )}
      <RiskLegend />
      <p className="text-xs text-muted-foreground">{t(lang, "map.draw_hint")}</p>
      <CoordForm onArea={onArea} />
      <p className="text-[11px] text-muted-foreground">{url.base === "sat" ? tf(lang, "map.gibs_note", { date: digits(lang, gdate) }) : ESRI_ATTR.replace(/<[^>]+>/g, "").replace("&amp;", "&").replace(/&copy;/g, "©")}</p>
    </div>
  );
}

function capMonth(lang: "en" | "bn" | "es", ym: string) {
  const s = monthYear(lang, ym, true);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Accessible alternative to drawing: a bounding box or pin + radius by numbers. */
function CoordForm({ onArea }: { onArea(p: Polygon): void }) {
  const { lang, area } = useApp();
  const b = area?.bbox;
  const [v, setV] = useState({ w: "", s: "", e: "", n: "" });
  const [pin, setPin] = useState({ lat: "", lon: "", r: "10" });
  useEffect(() => {
    if (b) setV({ w: b[0].toFixed(2), s: b[1].toFixed(2), e: b[2].toFixed(2), n: b[3].toFixed(2) });
  }, [b?.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const nums = [v.w, v.s, v.e, v.n].map(Number);
  const ok = nums.every(Number.isFinite) && nums[0]! < nums[2]! && nums[1]! < nums[3]!;
  const pinOk = [pin.lat, pin.lon, pin.r].map(Number).every(Number.isFinite) && Number(pin.r) > 0 && Number(pin.r) <= 200;
  const field = (k: keyof typeof v, label: string) => (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input inputMode="decimal" className="field w-full min-w-0 text-xs" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </label>
  );
  return (
    <details className="rounded-md border p-2 text-xs">
      <summary className="min-h-11 content-center font-medium">{t(lang, "map.bbox_title")}</summary>
      <p className="my-2 text-muted-foreground">{t(lang, "map.bbox_help")}</p>
      <form
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok) return;
          const [w, s, ee, n] = nums as [number, number, number, number];
          onArea([
            [w, s],
            [ee, s],
            [ee, n],
            [w, n],
          ]);
        }}
      >
        {field("w", t(lang, "map.min_lon"))}
        {field("s", t(lang, "map.min_lat"))}
        {field("e", t(lang, "map.max_lon"))}
        {field("n", t(lang, "map.max_lat"))}
        <button type="submit" disabled={!ok} className={cn("col-span-2 min-h-11 rounded-md bg-primary px-3 font-medium text-primary-foreground disabled:opacity-40 sm:col-span-4")}>
          {t(lang, "map.use_area")}
        </button>
      </form>
      <form
        className="mt-3 grid grid-cols-3 gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pinOk) onArea(circlePolygon(Number(pin.lon), Number(pin.lat), Number(pin.r)));
        }}
      >
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground">{t(lang, "col.lat")}</span>
          <input inputMode="decimal" className="field w-full min-w-0 text-xs" value={pin.lat} onChange={(e) => setPin({ ...pin, lat: e.target.value })} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground">{t(lang, "col.lon")}</span>
          <input inputMode="decimal" className="field w-full min-w-0 text-xs" value={pin.lon} onChange={(e) => setPin({ ...pin, lon: e.target.value })} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground">{t(lang, "map.radius")}</span>
          <input inputMode="decimal" className="field w-full min-w-0 text-xs" value={pin.r} onChange={(e) => setPin({ ...pin, r: e.target.value })} />
        </label>
        <button type="submit" disabled={!pinOk} className="col-span-3 min-h-11 rounded-md border border-input px-3 font-medium hover:bg-accent disabled:opacity-40">
          {t(lang, "map.pin_hint").split(":")[0]}
        </button>
      </form>
    </details>
  );
}
