# Notes for coding agents

- This project started from a Lovable (TanStack Start) template and was converted to a plain
  Vite + React static app (no SSR, no server). It no longer builds with Lovable's tooling.
- Run tools through the npm scripts (`npm run dev | test | build`). They call `node node_modules/...`
  directly because the folder name contains `;`.
- All statistics live in `src/compute/` and are covered by tests. Keep it that way: the Method
  tab states that every number shown is computed by tested code there.
- All UI strings live in `src/i18n/{en,bn,es}.json` with identical keys and placeholders
  (a test enforces this). Never hard-code the VIIRS start year; read `index.viirs_start`.
