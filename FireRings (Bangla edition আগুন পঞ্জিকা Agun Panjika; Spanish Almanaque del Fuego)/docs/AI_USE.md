# AI use disclosure (NASA Space Apps 2026)

Team HalluciNation used AI coding assistants to build FireRings. This file logs the prompts and what the AI was and was not allowed to do.

## Prompts used

1. **App build prompt pack**, `lovable-prompt-firerings.md`: Block 0 project rules and Prompts 1–5 (data layer, analysis tabs, inclusion, method and exports, real data and polish). Keep a copy in `docs/`. Status against every requirement: `docs/CHECKLIST.md`.
2. **ML Intelligence Layer master prompt**, `firerings-ml-layer-master-prompt.md`:
   - Part 0: shared context and non-negotiable rules
   - Part 1: Python backend in `src/compute/ml`
   - Part 2: frontend in `src/ml`

   Plans: `docs/ml_plan.md` and `docs/ml_frontend_plan.md`. Keep a copy of the prompt in `docs/`.
3. **Real NASA data prompt**: switch to real FIRMS / POWER / EONET data, additively. It covers:
   - ingest in `src/ingest`;
   - clean, grid and harmonize in `src/compute/pipeline`;
   - the seam test;
   - `make fetch | real | snapshot`;
   - the Method-tab card and citation.

   Plan: `docs/real_data_plan.md`. The API key stays in `.env`; it is never committed and never logged.

Tool: Claude Code (Anthropic), working inside the repository. Humans reviewed every change, ran the tests, and own the result.

## What AI does and does not do in the product

- **No AI or LLM computes or invents any number shown in the app.**
  - Statistics come from tested TypeScript in `src/compute/derive.ts`.
  - ML numbers come from tested Python in `src/compute/ml`: XGBoost, conformal prediction, TreeSHAP and FireCast. These are classical, CPU-only models, not language models.
- Plain-language sentences are **templates** filled with computed fields (`src/i18n/summaries.ts`, `src/compute/ml/narrative.py`).
  - Optional LLM polishing of the ML narrative is **off**.
  - If it is ever enabled, `numbers_grounded` rejects any text containing a number that is not among the source facts.
- The demo build runs on **synthetic** inputs and labels every number `demo`.
