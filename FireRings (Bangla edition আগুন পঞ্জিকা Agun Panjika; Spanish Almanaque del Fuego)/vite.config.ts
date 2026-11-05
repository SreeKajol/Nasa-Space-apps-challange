import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * Writes precache.json (every emitted file + a build id) so the service
 * worker can cache the whole app shell on first visit and work offline.
 */
function precacheManifest(): Plugin {
  return {
    name: "firerings-precache",
    apply: "build",
    generateBundle(_opts, bundle) {
      // Skip what browsers never fetch here: source maps, legacy .woff (every
      // target loads .woff2) and Inter subsets for scripts the app doesn't use.
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map") && !f.endsWith(".woff") && !/inter-(cyrillic|greek|vietnamese)/.test(f));
      const id = Date.now().toString(36);
      this.emitFile({ type: "asset", fileName: "precache.json", source: JSON.stringify({ id, files }) });
    },
  };
}

/**
 * Loads the app stylesheet without blocking first paint, so the static shell
 * in index.html (inline-styled) shows as soon as the HTML arrives on slow
 * networks. The app waits for the sheet before mounting (src/lib/boot.ts).
 */
function nonBlockingCss(): Plugin {
  return {
    name: "firerings-nonblocking-css",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(/<link rel="stylesheet"( crossorigin)? href="([^"]+\.css)">/g, (_m, co: string | undefined, href: string) =>
          `<link rel="stylesheet" data-fr-css${co ?? ""} href="${href}" media="print" onload="this.media='all'"><noscript><link rel="stylesheet" href="${href}"></noscript>`,
        );
      },
    },
  };
}

// Plain static multi-page app: no server, no SSR. `base: "./"` lets `dist/`
// be hosted under any path, or served from a local folder.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), precacheManifest(), nonBlockingCss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 300,
    rolldownOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        almanac: path.resolve(import.meta.dirname, "almanac/index.html"),
      },
    },
  },
});
