/** Register the offline service worker (production builds only). */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    const url = new URL("sw.js", new URL(import.meta.env.BASE_URL, window.location.href)).href.replace(/almanac\/sw\.js$/, "sw.js");
    navigator.serviceWorker.register(url, { scope: url.replace(/sw\.js$/, "") }).catch(() => {
      /* offline support is a progressive enhancement */
    });
  });
}
