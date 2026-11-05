/**
 * Resolves once the app stylesheets are applied. The build loads them
 * without blocking first paint (see `nonBlockingCss` in vite.config.ts), so
 * the static shell in index.html can show immediately on slow networks; the
 * app mounts only after its CSS is ready, so it never flashes unstyled.
 */
export function stylesReady(): Promise<void> {
  const pending = [...document.querySelectorAll<HTMLLinkElement>('link[data-fr-css]')].filter((l) => l.media !== "all");
  return Promise.all(
    pending.map(
      (l) =>
        new Promise<void>((resolve) => {
          const done = () => requestAnimationFrame(() => resolve());
          l.addEventListener("load", done, { once: true });
          l.addEventListener("error", () => resolve(), { once: true });
          // Safety net: never hold the app back for more than 4 s.
          setTimeout(resolve, 4000);
        }),
    ),
  ).then(() => undefined);
}
