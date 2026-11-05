import "@fontsource-variable/inter";
import "@fontsource/noto-sans-bengali/bengali-400.css";
import "@fontsource/noto-sans-bengali/bengali-600.css";
import "../styles.css";
import "./almanac.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { startTransition, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadLang } from "@/i18n";
import { stylesReady } from "@/lib/boot";
import { parseState } from "@/state/url";
import { AppProvider } from "@/state/app";
import { SettingsProvider } from "@/state/settings";
import { registerServiceWorker } from "@/lib/pwa";
import { Almanac } from "./Almanac";

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, networkMode: "always" } } });

// Load the page language before the first paint (English is built in).
await Promise.all([loadLang(parseState(window.location.search).lang).catch(() => {}), stylesReady()]);

// Time-sliced first render: the static shell stays up while React builds the app.
const root = createRoot(document.getElementById("root")!);
startTransition(() =>
  root.render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <SettingsProvider>
        <AppProvider>
          <Almanac />
        </AppProvider>
      </SettingsProvider>
    </QueryClientProvider>
  </StrictMode>,
  ),
);

registerServiceWorker();
