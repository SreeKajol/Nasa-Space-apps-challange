import { CalendarRange, Download, HelpCircle, Image, Info, Link2, Moon, Printer, Search, Settings2, SlidersHorizontal, Sun, Table, Type, Volume2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { circlePolygon } from "@/compute/derive";
import { availableSources } from "@/data/provider";
import { baseMode, MODES, type Mode } from "@/data/view";
import { capFirst, digits, LANGS, loadLang, monthYear, t, tf, type Lang } from "@/i18n";
import { unitFor } from "@/i18n/summaries";
import { calendarPng, hotspotsRangeCsv, monthlyCsv } from "@/lib/exports";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/app";
import { useSettings } from "@/state/settings";
import { serializeState } from "@/state/url";
import { addMonths, parseYm, ymOf } from "@/data/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { useCalendarModel } from "./charts/BurningCalendar";
import { Segmented } from "./common";
import { Drawer, Modal } from "./Drawer";
import { HearSeason } from "./HearSeason";
import { Logo } from "./Logo";
import { downloadFile } from "./hooks";

const iconBtn = "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-ember-soft aria-pressed:text-ember-text";

/* ---------------- area search (combobox) ---------------- */

export function AreaSearch({ className }: { className?: string }) {
  const { lang, index, area, setUrl } = useApp();
  const id = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const out: { key: string; label: string; sub: string; pick(): void }[] = [];
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        out.push({
          key: "pt",
          label: tf(lang, "bar.search_latlon", { lat: digits(lang, lat.toFixed(3)), lon: digits(lang, lon.toFixed(3)), km: digits(lang, 10) }),
          sub: "",
          pick: () => setUrl({ poly: circlePolygon(lon, lat, 10), area: "custom", m: null }),
        });
      }
    }
    const needle = q.trim().toLowerCase();
    for (const p of index?.presets ?? []) {
      const names = [p.name.en, p.name.bn, p.name.es, p.country].join(" ").toLowerCase();
      if (!needle || names.includes(needle)) {
        out.push({ key: p.id, label: p.name[lang], sub: p.country, pick: () => setUrl({ area: p.id, poly: null, m: null }) });
      }
    }
    return out;
  }, [q, index, lang, setUrl]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    o.pick();
    setQ("");
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className={cn("relative", className)} id="area-search">
      <label htmlFor={`${id}-in`} className="sr-only">
        {t(lang, "bar.search_label")}
      </label>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        ref={input}
        id={`${id}-in`}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${id}-o-${active}` : undefined}
        placeholder={area ? area.name : t(lang, "bar.search_ph")}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(options.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(active);
          } else if (e.key === "Escape") setOpen(false);
        }}
        className="field w-full pl-9 placeholder:text-foreground/70"
      />
      {open && (
        <ul id={`${id}-list`} role="listbox" aria-label={t(lang, "bar.search_label")} className="absolute top-full right-0 left-0 z-[1100] mt-1 max-h-72 overflow-auto rounded-md border bg-popover p-1 shadow-lg">
          {options.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground" role="option" aria-selected={false} aria-disabled="true">
              {t(lang, "bar.search_none")}
            </li>
          ) : (
            options.map((o, i) => (
              <li
                key={o.key}
                id={`${id}-o-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(i);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn("flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-sm px-3 text-sm", i === active && "bg-accent")}
              >
                <span>{o.label}</span>
                {o.sub && <span className="text-xs text-muted-foreground">{o.sub}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/* ---------------- date range ---------------- */

export function DateRange({ inline = false }: { inline?: boolean }) {
  const { lang, index, from, to, setUrl } = useApp();
  if (!index) return null;
  const last = index.last_month;
  const ly = parseYm(last).y;
  const presets = [
    { k: "range.full" as const, f: index.first_month, t: last },
    { k: "range.last5" as const, f: ymOf(ly - 4, 1), t: last },
    { k: "range.last1" as const, f: addMonths(last, -11), t: last },
  ];
  const body = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.k}
            type="button"
            aria-pressed={from === p.f && to === p.t}
            onClick={() => setUrl({ from: p.f === index.first_month ? null : p.f, to: null })}
            className="min-h-11 rounded-md border border-input px-3 text-xs font-medium hover:bg-accent aria-pressed:border-ember aria-pressed:bg-ember-soft"
          >
            {t(lang, p.k)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t(lang, "ctrl.from")}</span>
          <input type="month" className="field" min={index.first_month} max={to} value={from} onChange={(e) => e.target.value && setUrl({ from: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t(lang, "ctrl.to")}</span>
          <input type="month" className="field" min={from} max={last} value={to} onChange={(e) => e.target.value && setUrl({ to: e.target.value })} />
        </label>
      </div>
    </div>
  );
  if (inline) return body;
  return (
    <Popover>
      <PopoverTrigger className="field inline-flex items-center gap-2 text-sm whitespace-nowrap hover:bg-accent" aria-label={`${t(lang, "ctrl.range")}: ${monthYear(lang, from, true)} – ${monthYear(lang, to, true)}`}>
        <CalendarRange className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="tabular">
          {capFirst(monthYear(lang, from, true))} – {monthYear(lang, to, true)}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-auto" align="start">
        {body}
      </PopoverContent>
    </Popover>
  );
}

/* ---------------- sensor mode ---------------- */

export function ModeSwitch() {
  const { lang, url, setUrl } = useApp();
  return (
    <Segmented<Mode>
      label={t(lang, "bar.mode_label")}
      value={url.mode}
      onChange={(m) => setUrl({ mode: m })}
      options={MODES.map((m) => ({ id: m, label: t(lang, `mode.${m}`), title: t(lang, "mode.help") }))}
    />
  );
}

/* ---------------- export ---------------- */

function ExportMenu() {
  const app = useApp();
  const { lang, region, req, area, from, to, url, provOpts } = app;
  const { ramp } = useSettings();
  const model = useCalendarModel();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const base = `firerings_${area?.id ?? "area"}_${from}_${to}`;
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setNote(t(lang, "exp.working"));
    try {
      await f();
      setNote("");
    } catch {
      setNote(t(lang, "err.load"));
    } finally {
      setBusy(false);
    }
  };
  const disabled = !region || !req;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(iconBtn, "w-auto gap-1.5 px-3 text-sm font-medium text-foreground")} aria-busy={busy}>
          <Download className="size-4" aria-hidden="true" />
          <span className="hidden 2xl:inline">{t(lang, "bar.export")}</span>
          <span className="sr-only 2xl:hidden">{t(lang, "bar.export")}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[1200] w-64">
          <DropdownMenuItem className="min-h-11" disabled={disabled} onSelect={() => run(async () => downloadFile(`${base}_hotspots.csv`, "text/csv", await hotspotsRangeCsv(url.src, provOpts, req!, from, to)))}>
            <Table className="size-4" aria-hidden="true" /> {t(lang, "exp.hotspots")}
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" disabled={disabled} onSelect={() => downloadFile(`${base}_monthly.csv`, "text/csv", monthlyCsv(region!, from, to))}>
            <Table className="size-4" aria-hidden="true" /> {t(lang, "exp.monthly")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11"
            disabled={disabled || !model}
            onSelect={() =>
              run(async () => {
                const blob = await calendarPng({
                  model: model!,
                  lang,
                  ramp,
                  title: `${area!.name} — ${t(lang, "cal.title")}`,
                  subtitle: `${t(lang, `mode.${url.mode}`)} · ${monthYear(lang, from, true)} – ${monthYear(lang, to, true)}${region?.source === "demo" ? ` · ${t(lang, "badge.demo")}` : ""}`,
                  unit: unitFor(lang, baseMode(url.mode)),
                });
                const href = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = href;
                a.download = `${base}_calendar.png`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(href), 1000);
              })
            }
          >
            <Image className="size-4" aria-hidden="true" /> {t(lang, "exp.png")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="min-h-11"
            onSelect={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                setNote(t(lang, "exp.copied"));
              } catch {
                setNote(window.location.href);
              }
              setTimeout(() => setNote(""), 3000);
            }}
          >
            <Link2 className="size-4" aria-hidden="true" /> {t(lang, "exp.share")}
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" disabled={!area} asChild>
            <a href={`./almanac/${serializeState({ ...url, m: null })}`} target="_blank" rel="noopener">
              <Printer className="size-4" aria-hidden="true" /> {t(lang, "exp.print")}
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span role="status" aria-live="polite" className={cn("text-xs text-muted-foreground", !note && "sr-only")}>
        {note}
      </span>
    </>
  );
}

/* ---------------- settings / help / about ---------------- */

function SettingsPopover() {
  const { lang, url, setUrl, isDemo } = useApp();
  const s = useSettings();
  const sources = availableSources();
  return (
    <Popover>
      <PopoverTrigger className={iconBtn} aria-label={t(lang, "set.title")}>
        <Settings2 className="size-5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="z-[1200] w-72 space-y-4">
        <h2 className="text-sm font-semibold">{t(lang, "set.title")}</h2>
        <Field label={t(lang, "ctrl.ramp")}>
          <select className="field w-full" value={s.ramp} onChange={(e) => s.set({ ramp: e.target.value as "inferno" | "cividis" })}>
            <option value="inferno">{t(lang, "ramp.inferno")}</option>
            <option value="cividis">{t(lang, "ramp.cividis")}</option>
          </select>
        </Field>
        {sources.length > 1 && (
          <Field label={t(lang, "ctrl.src")}>
            <select className="field w-full" value={url.src} onChange={(e) => setUrl({ src: e.target.value as "demo" | "static" })}>
              <option value="static">{t(lang, "prov.live")}</option>
              <option value="demo">{t(lang, "src.demo")}</option>
            </select>
          </Field>
        )}
        {isDemo && (
          <Field label={t(lang, "set.viirs")}>
            <select className="field w-full" value={s.viirsStart} onChange={(e) => s.set({ viirsStart: e.target.value as "2012-01" | "2018-01" })}>
              <option value="2012-01">{t(lang, "set.viirs_2012")}</option>
              <option value="2018-01">{t(lang, "set.viirs_2018")}</option>
            </select>
          </Field>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const { lang } = useApp();
  const s = useSettings();
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t(lang, "help.title")} closeLabel={t(lang, "dr.close")}>
      <ul className="list-disc space-y-2 pl-5 text-sm">
        <li>{t(lang, "help.calendar")}</li>
        <li>{t(lang, "help.status")}</li>
        <li>{t(lang, "help.modes")}</li>
        <li>{t(lang, "help.keys")}</li>
        <li>{t(lang, "help.prov")}</li>
        <li>{t(lang, "hear.explain")}</li>
      </ul>
      <button
        type="button"
        className="mt-4 min-h-11 rounded-md border border-input px-4 text-sm font-medium hover:bg-accent"
        onClick={() => {
          s.set({ tourDone: false });
          onOpenChange(false);
        }}
      >
        {t(lang, "help.tour")}
      </button>
    </Modal>
  );
}

export function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const { lang } = useApp();
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t(lang, "about.title")} closeLabel={t(lang, "dr.close")}>
      <div className="space-y-3 text-sm">
        <p>{t(lang, "about.p1")}</p>
        <p>{t(lang, "about.p2")}</p>
        <p>{t(lang, "about.p3")}</p>
        <p className="font-medium">{t(lang, "about.challenge")}</p>
        <div>
          <h3 className="font-semibold">{t(lang, "about.team")}</h3>
          {/* Placeholders — replace with the team's names and roles. */}
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            <li>Member 1 — data pipeline</li>
            <li>Member 2 — harmonization model</li>
            <li>Member 3 — design &amp; accessibility</li>
            <li>Member 4 — front end</li>
          </ul>
        </div>
        <p>
          {t(lang, "about.repo")}:{" "}
          <a className="text-ember-text underline" href="https://github.com/your-team/firerings" target="_blank" rel="noopener noreferrer">
            github.com/your-team/firerings
          </a>
        </p>
        <p className="border-t pt-3 text-xs text-muted-foreground">{t(lang, "footer.text")}</p>
      </div>
    </Modal>
  );
}

/* ---------------- the bar ---------------- */

export function TopBar() {
  const { lang, url, setUrl, isDemo, area } = useApp();
  const s = useSettings();
  const [help, setHelp] = useState(false);
  const [about, setAbout] = useState(false);
  const [filters, setFilters] = useState(false);
  const nextTheme = s.dark ? "light" : "dark";
  const hdr = useRef<HTMLElement>(null);
  // Publish the header height so sticky panels sit right below it.
  useEffect(() => {
    const el = hdr.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--hdr", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <header ref={hdr} className="sticky top-0 z-[1000] border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
        <a href={`./${serializeState({ ...url, area: null, poly: null, m: null })}`} className="mr-1 flex min-h-11 items-center gap-2" aria-label={`${t(lang, "app.title")} — ${t(lang, "app.tagline")}`}>
          <Logo className="size-8 text-foreground" />
          <span className="leading-tight">
            <span className="block text-base font-semibold">{t(lang, "app.title")}</span>
            <span className="hidden text-[11px] text-muted-foreground sm:block lg:hidden 2xl:block">{t(lang, "app.tagline")}</span>
          </span>
        </a>
        {isDemo && (
          <span className="prov prov-demo" title={t(lang, "badge.demo_tip")}>
            <span aria-hidden="true">○</span> {t(lang, "badge.demo")}
            <span className="sr-only">: {t(lang, "badge.demo_tip")}</span>
          </span>
        )}

        <div className="order-last flex w-full flex-wrap items-center gap-2 lg:flex-nowrap 2xl:order-none 2xl:w-auto 2xl:flex-1 2xl:justify-center">
          <AreaSearch className="min-w-[12rem] flex-1 lg:w-72 lg:flex-none" />
          <div className="hidden items-center gap-2 lg:flex">
            <DateRange />
            <ModeSwitch />
          </div>
          <button type="button" className={cn(iconBtn, "w-auto gap-1.5 border border-input px-3 text-sm text-foreground lg:hidden")} onClick={() => setFilters(true)}>
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            {t(lang, "bar.filters")}
          </button>
        </div>

        <div className="ml-auto flex items-center gap-0.5">
          <label className="sr-only" htmlFor="lang-select">
            {t(lang, "ctrl.lang")}
          </label>
          <select id="lang-select" className="field min-h-11 w-[5.5rem] text-sm" value={lang} onChange={(e) => {
              const next = e.target.value as Lang;
              void loadLang(next).then(() => setUrl({ lang: next }));
            }}>
            {LANGS.map((l) => (
              <option key={l.id} value={l.id} lang={l.bcp47}>
                {l.short}
              </option>
            ))}
          </select>
          <button type="button" className={iconBtn} onClick={() => s.set({ theme: nextTheme })} aria-label={tf(lang, "bar.theme_toggle", { theme: t(lang, `theme.${nextTheme}`) })}>
            {s.dark ? <Sun className="size-5" aria-hidden="true" /> : <Moon className="size-5" aria-hidden="true" />}
          </button>
          <button type="button" className={iconBtn} aria-pressed={s.simple} onClick={() => s.set({ simple: !s.simple })} aria-label={t(lang, "bar.simple")} title={t(lang, "bar.simple")}>
            <Type className="size-5" aria-hidden="true" />
          </button>
          {area && (
            <Popover>
              <PopoverTrigger className={cn(iconBtn, "hidden sm:inline-flex")} aria-label={t(lang, "hear.title")} title={t(lang, "hear.title")}>
                <Volume2 className="size-5" aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent align="end" className="z-[1200] w-auto max-w-[min(26rem,95vw)]">
                <HearSeason />
              </PopoverContent>
            </Popover>
          )}
          <ExportMenu />
          <SettingsPopover />
          <button type="button" className={iconBtn} onClick={() => setHelp(true)} aria-label={t(lang, "bar.help")} title={t(lang, "bar.help")}>
            <HelpCircle className="size-5" aria-hidden="true" />
          </button>
          <button type="button" className={iconBtn} onClick={() => setAbout(true)} aria-label={t(lang, "bar.about")} title={t(lang, "bar.about")}>
            <Info className="size-5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <Drawer open={filters} onOpenChange={setFilters} title={t(lang, "bar.filters")} closeLabel={t(lang, "dr.close")} side="bottom" modal>
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t(lang, "ctrl.range")}</h3>
          <DateRange inline />
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t(lang, "bar.mode_label")}</h3>
          <div className="scroll-x">
            <ModeSwitch />
          </div>
          <p className="text-xs text-muted-foreground">{t(lang, "mode.help")}</p>
        </section>
        {area && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t(lang, "hear.title")}</h3>
            <HearSeason compact />
          </section>
        )}
      </Drawer>
      <HelpDialog open={help} onOpenChange={setHelp} />
      <AboutDialog open={about} onOpenChange={setAbout} />
    </header>
  );
}
