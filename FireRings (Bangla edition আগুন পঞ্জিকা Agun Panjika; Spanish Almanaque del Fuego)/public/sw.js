/*
 * FireRings service worker — offline-first.
 *  - App shell: precached on install from precache.json (written at build).
 *  - Pages: network-first, falling back to the cached shell.
 *  - Data files (.json / .csv): network-first; offline answers come from the
 *    cache and carry `x-fr-cache: 1` so the UI can label them "cache".
 *  - Map tiles (NASA GIBS, Esri): stale-while-revalidate, capped.
 */
const SHELL = "fr-shell";
const DATA = "firerings-data-v1"; // shared with the StaticJsonAdapter
const TILES = "fr-tiles-v1";
const MAX_TILES = 800;

const scope = new URL(self.registration.scope);
const rel = (p) => new URL(p, scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      let manifest = { id: "dev", files: [] };
      try {
        manifest = await (await fetch(rel("precache.json"), { cache: "no-store" })).json();
      } catch {
        /* first offline install: nothing to precache */
      }
      const cache = await caches.open(`${SHELL}-${manifest.id}`);
      const urls = ["./", "index.html", "almanac/", "almanac/index.html", "manifest.webmanifest", "favicon.svg", ...manifest.files].map(rel);
      await Promise.all(urls.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const shells = keys.filter((k) => k.startsWith(SHELL));
      // keep only the newest shell cache (the one with the most recent install)
      for (const k of shells.slice(0, -1)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

async function shellMatch(request) {
  const keys = (await caches.keys()).filter((k) => k.startsWith(SHELL));
  for (const k of keys.reverse()) {
    const hit = await (await caches.open(k)).match(request, { ignoreSearch: true });
    if (hit) return hit;
  }
  return undefined;
}

function markCached(res) {
  const headers = new Headers(res.headers);
  headers.set("x-fr-cache", "1");
  return res.blob().then((b) => new Response(b, { status: res.status, statusText: res.statusText, headers }));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Pages
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => {
        const page = url.pathname.includes("/almanac") ? rel("almanac/index.html") : rel("index.html");
        return (await shellMatch(page)) ?? Response.error();
      }),
    );
    return;
  }

  // Map tiles
  if (/gibs\.earthdata\.nasa\.gov|server\.arcgisonline\.com/.test(url.host)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILES);
        const hit = await cache.match(req);
        const net = fetch(req)
          .then(async (res) => {
            if (res.ok || res.type === "opaque") {
              await cache.put(req, res.clone());
              const keys = await cache.keys();
              if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
            }
            return res;
          })
          .catch(() => hit ?? Response.error());
        return hit ?? net;
      })(),
    );
    return;
  }

  // Data files
  if (/\.(json|csv)$/.test(url.pathname) && !url.pathname.endsWith("precache.json") && !url.pathname.endsWith(".webmanifest")) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            const headers = new Headers(res.headers);
            headers.set("x-fr-saved-at", new Date().toISOString());
            const body = await res.clone().blob();
            (await caches.open(DATA)).put(req.url, new Response(body, { headers })).catch(() => {});
          }
          return res;
        } catch {
          const hit = await caches.match(req.url);
          return hit ? markCached(hit) : Response.error();
        }
      })(),
    );
    return;
  }

  // App assets (same origin): cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const hit = await shellMatch(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) {
          const keys = (await caches.keys()).filter((k) => k.startsWith(SHELL));
          const name = keys[keys.length - 1] ?? `${SHELL}-runtime`;
          (await caches.open(name)).put(req, res.clone()).catch(() => {});
        }
        return res;
      })(),
    );
  }
});
