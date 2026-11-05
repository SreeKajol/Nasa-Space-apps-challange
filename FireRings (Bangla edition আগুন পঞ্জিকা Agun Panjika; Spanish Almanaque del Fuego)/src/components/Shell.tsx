import { CalendarDays, ChartLine, CircleDot, FlaskConical, MapIcon, WifiOff, BarChart3, Sparkles } from "lucide-react";
import { lazy, startTransition, Suspense, useEffect, useState, type ReactNode } from "react";
import { baseMode } from "@/data/view";
import { dateLong, digits, num, t, tf } from "@/i18n";
import { nowSummary } from "@/i18n/summaries";
import { cn } from "@/lib/utils";
import { useMl } from "@/ml/hooks";
import { mt } from "@/ml/i18n";
import { AlertStrip, IntelligenceTab } from "@/ml/inline";
import { useApp } from "@/state/app";
import { useMedia } from "@/state/settings";
import { TABS, type Tab } from "@/state/url";
import { BurningCalendar } from "./charts/BurningCalendar";
import { ErrorBoundary, ErrorState, ProvenanceBadge, Skeleton, WhenVisible } from "./common";
import { useOnline } from "./hooks";
import { HotspotTable } from "./HotspotTable";
import { KpiRow, OutlookCard } from "./Kpis";
import { MonthDrawer } from "./MonthDrawer";
import { TopBar } from "./TopBar";
import { Tour } from "./Tour";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const MapPanel = lazy(() => import("./map/MapPanel"));
const FireRings = lazy(() => import("./charts/FireRings").then((m) => ({ default: m.FireRings })));
const TimeSeries = lazy(() => import("./charts/TimeSeries").then((m) => ({ default: m.TimeSeries })));
const MonthlyProfile = lazy(() => import("./charts/MonthlyProfile").then((m) => ({ default: m.MonthlyProfile })));
const MethodTab = lazy(() => import("./MethodTab").then((m) => ({ default: m.MethodTab })));

const TAB_ICON: Record<Tab, ReactNode> = {
  calendar: <CalendarDays className="size-4" aria-hidden="true" />,
  rings: <CircleDot className="size-4" aria-hidden="true" />,
  series: <ChartLine className="size-4" aria-hidden="true" />,
  profile: <BarChart3 className="size-4" aria-hidden="true" />,
  method: <FlaskConical className="size-4" aria-hidden="true" />,
  intel: <Sparkles className="size-4" aria-hidden="true" />,
};
const TAB_LABEL: Record<Exclude<Tab, "intel">, "tab.calendar" | "tab.rings" | "tab.series" | "tab.profile" | "tab.method"> = {
  calendar: "tab.calendar",
  rings: "tab.rings",
  series: "tab.series",
  profile: "tab.profile",
  method: "tab.method",
};

function SkipLinks() {
  const { lang, setUrl, area } = useApp();
  return (
    <>
      <a href="#main" className="skip-link">
        {t(lang, "a11y.skip")}
      </a>
      {area && (
        <a
          href="#analysis"
          className="skip-link"
          onClick={(e) => {
            e.preventDefault();
            setUrl({ tab: "calendar" });
            window.setTimeout(() => (document.querySelector("#calendar [role=grid]") as HTMLElement | null)?.focus(), 50);
          }}
        >
          {t(lang, "a11y.skip_cal")}
        </a>
      )}
    </>
  );
}

function OfflineBanner() {
  const online = useOnline();
  const { lang, isDemo, region } = useApp();
  if (online) return null;
  const text = isDemo ? t(lang, "off.demo") : region?.saved_at ? tf(lang, "off.saved", { date: dateLong(lang, region.saved_at) }) : t(lang, "off.plain");
  return (
    <div role="status" className="border-b bg-muted px-4 py-2 text-center text-sm">
      <WifiOff className="mr-2 inline size-4 align-[-3px]" aria-hidden="true" />
      {text}
    </div>
  );
}

function PresetChips() {
  const { lang, index, area, setUrl } = useApp();
  if (!index) return <Skeleton className="mb-1 h-11 w-full" />;
  return (
    <nav aria-label={t(lang, "map.places")} className="scroll-x -mx-1 flex gap-2 px-1 pb-1">
      {index.presets.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={area?.id === p.id}
          onClick={() => setUrl({ area: p.id, poly: null, m: null })}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-input px-3 text-sm whitespace-nowrap hover:bg-accent aria-pressed:border-[var(--ember)] aria-pressed:bg-ember-soft aria-pressed:font-semibold"
        >
          {p.name[lang]}
          <span className="text-[10px] text-muted-foreground">{p.country}</span>
        </button>
      ))}
    </nav>
  );
}

/** Selected area under the preset chips: name, size and (for drawn areas) a clear button. */
function MapCaption() {
  const { lang, area, url, setUrl } = useApp();
  // Reserve the row while the index loads, so content below does not jump (CLS).
  if (!area) return url.area || url.poly ? <div className="min-h-11" aria-hidden="true" /> : null;
  return (
    <div className="flex min-h-11 items-center justify-between gap-2 text-sm">
      <p className="flex min-w-0 items-center gap-2">
        <span className="inline-block size-3 shrink-0 rounded-sm border-2 border-[var(--ember)]" aria-hidden="true" />
        <strong className="truncate font-semibold">{area.name}</strong>
        <span className="tabular shrink-0 text-muted-foreground">{tf(lang, "area.size", { km2: num(lang, Math.round(area.km2)) })}</span>
      </p>
      {area.custom && (
        <button type="button" onClick={() => setUrl({ poly: null, area: null, m: null })} className="min-h-11 shrink-0 rounded-md border border-input px-3 text-xs font-medium hover:bg-accent">
          {t(lang, "map.clear")}
        </button>
      )}
    </div>
  );
}

function AreaHeader() {
  const { lang, area, region, index, hview } = useApp();
  if (!area) return null;
  return (
    <div className="space-y-2">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="text-xl font-semibold sm:text-3xl">{area.name}</h1>
      <span className="tabular text-sm text-muted-foreground">{tf(lang, "area.size", { km2: num(lang, Math.round(area.km2)) })}</span>
      {region?.approximate && (
        <span className="prov" title={tf(lang, "area.approx_tip", { km: digits(lang, index?.grid.cell_km ?? 5.5) })}>
          ≈ {t(lang, "area.approx")} · {tf(lang, "area.cells", { n: num(lang, region.cell_count ?? 0) })}
        </span>
      )}
      <ProvenanceBadge source={region?.source} lang={lang} savedAt={region?.saved_at} />
    </div>
      {/* The one sentence a busy officer needs, in plain language (also announced). */}
      {region && hview ? (
        <p className="max-w-3xl text-xl leading-snug text-foreground/90" aria-live="polite">
          {nowSummary(lang, region, hview.points)}
        </p>
      ) : (
        <Skeleton className="h-6 w-3/4" />
      )}
    </div>
  );
}

/** Mount children one frame after the first paint, so the header and KPIs show first. */
function useAfterFirstPaint(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let t = 0;
    const raf = requestAnimationFrame(() => {
      // A transition lets React render the calendar in small, interruptible slices.
      t = window.setTimeout(() => startTransition(() => setReady(true)), 0);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, []);
  return ready;
}

function EmptyState() {
  const { lang, index, setUrl } = useApp();
  return (
    <section className="card flex flex-col items-center gap-4 p-8 text-center" aria-labelledby="empty-h">
      <MapIcon className="size-10 text-ember" aria-hidden="true" />
      <h1 id="empty-h" className="text-xl font-semibold">
        {t(lang, "empty.title")}
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">{t(lang, "empty.body")}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {index?.presets.map((p) => (
          <button key={p.id} type="button" onClick={() => setUrl({ area: p.id, poly: null })} className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">
            {p.name[lang]}
          </button>
        ))}
      </div>
    </section>
  );
}

function TabFallback() {
  return <Skeleton className="h-96 w-full" />;
}

function LazyTab({ children }: { children: ReactNode }) {
  const { lang } = useApp();
  return (
    <ErrorBoundary fallback={<ErrorState lang={lang} error={null} />}>
      <Suspense fallback={<TabFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function Dashboard() {
  const { lang, url, setUrl, regionQ, region } = useApp();
  const ready = useAfterFirstPaint();
  const ml = useMl();
  if (regionQ.isError) return <ErrorState lang={lang} error={regionQ.error} onRetry={() => void regionQ.refetch()} />;
  if (!region)
    return (
      <div className="space-y-4" aria-busy="true" aria-label={t(lang, "loading")}>
        <div className="grid gap-3 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-[28rem] w-full" />
      </div>
    );
  const bm = baseMode(url.mode);
  return (
    <div className="space-y-4">
      {bm !== "harmonized" && (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm" role="status">
          {tf(lang, "mode.raw_note", { sensor: t(lang, `mode.${bm}`) })}
        </p>
      )}
      <AlertStrip />
      <KpiRow />
      <OutlookCard />
      <Tabs id="analysis" value={url.tab === "intel" && ml.missing ? "calendar" : url.tab} onValueChange={(v) => setUrl({ tab: v as Tab })}>
        <div className="scroll-x -mx-1 px-1">
          <TabsList aria-label={t(lang, "tabs.label")} className="h-auto gap-1 rounded-lg p-1">
            {TABS.map((tab) =>
              tab === "intel" ? (
                ml.ready && (
                  <TabsTrigger key={tab} value={tab} className="min-h-11 gap-1.5 px-3">
                    {TAB_ICON[tab]}
                    {mt(lang, "tab")}
                  </TabsTrigger>
                )
              ) : (
                <TabsTrigger key={tab} value={tab} className="min-h-11 gap-1.5 px-3">
                  {TAB_ICON[tab]}
                  {t(lang, TAB_LABEL[tab])}
                </TabsTrigger>
              ),
            )}
          </TabsList>
        </div>
        <TabsContent value="calendar" className="mt-3">
          {ready ? <BurningCalendar /> : <TabFallback />}
        </TabsContent>
        <TabsContent value="rings" className="mt-3">
          <LazyTab><FireRings /></LazyTab>
        </TabsContent>
        <TabsContent value="series" className="mt-3">
          <LazyTab><TimeSeries /></LazyTab>
        </TabsContent>
        <TabsContent value="profile" className="mt-3">
          <LazyTab><MonthlyProfile /></LazyTab>
        </TabsContent>
        <TabsContent value="method" className="mt-3">
          <LazyTab><MethodTab /></LazyTab>
        </TabsContent>
        <TabsContent value="intel" className="mt-3">
          {ml.ready ? <LazyTab><IntelligenceTab /></LazyTab> : <TabFallback />}
        </TabsContent>
      </Tabs>
      <WhenVisible minHeight="34rem">
        <HotspotTable />
      </WhenVisible>
    </div>
  );
}

function Footer() {
  return (
    <footer className="mx-auto max-w-[110rem] border-t px-4 py-6 text-xs text-muted-foreground">
      <p lang="en">{t("en", "footer.text")}</p>
    </footer>
  );
}

export function Shell() {
  const { lang, area, indexQ } = useApp();
  // Phones start with the map folded away, so Leaflet and tiles load only on request.
  const desktop = useMedia("(min-width: 1024px)");
  const [mapOpen, setMapOpen] = useState(false);
  const showMap = desktop || mapOpen;

  useEffect(() => {
    document.documentElement.lang = lang === "bn" ? "bn" : lang;
    document.title = area ? `${area.name} — ${t(lang, "app.title")}` : `${t(lang, "app.title")} — ${t(lang, "app.tagline")}`;
  }, [lang, area]);

  return (
    <div className="min-h-dvh">
      <SkipLinks />
      <TopBar />
      <OfflineBanner />
      <main id="main" tabIndex={-1} className="mx-auto grid min-h-dvh max-w-[110rem] content-start grid-cols-[minmax(0,1fr)] gap-4 px-3 py-4 outline-none sm:px-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <aside className="flex min-w-0 flex-col gap-2 lg:sticky lg:top-[calc(var(--hdr,4.5rem)+1rem)] lg:h-[calc(100dvh-var(--hdr,4.5rem)-2rem)]" aria-label={t(lang, "map.places")}>
          <PresetChips />
          <MapCaption />
          <button type="button" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-input text-sm lg:hidden" aria-expanded={mapOpen} aria-controls="map-wrap" onClick={() => setMapOpen((o) => !o)}>
            <MapIcon className="size-4" aria-hidden="true" />
            {mapOpen ? t(lang, "map.hide") : t(lang, "map.show")}
          </button>
          <div id="map-wrap" className={cn("min-h-0 flex-1 flex-col lg:flex", mapOpen ? "flex h-[60dvh] lg:h-auto" : "hidden")}>
            {showMap && (
              <ErrorBoundary fallback={<ErrorState lang={lang} error={null} />}>
                <Suspense fallback={<Skeleton className="h-full min-h-[18rem] w-full" />}>
                  <MapPanel />
                </Suspense>
              </ErrorBoundary>
            )}
          </div>
        </aside>
        <div className="min-w-0 space-y-4">
          {indexQ.isError ? (
            <ErrorState lang={lang} error={indexQ.error} onRetry={() => void indexQ.refetch()} />
          ) : !indexQ.data ? (
            <Skeleton className="h-64 w-full" />
          ) : !area ? (
            <EmptyState />
          ) : (
            <>
              <AreaHeader />
              <Dashboard />
            </>
          )}
        </div>
      </main>
      <Footer />
      <MonthDrawer />
      <Tour />
    </div>
  );
}
