# FireRings Intelligence layer. `make ml` = features -> harmonize_ml -> conformal
# -> explain -> firecast -> narrative -> export, then copies the JSON for the app.
#
#   make ml                        # pipeline files in data-products/ if present, else demo inputs
#   make ml DATA=data-products     # force the real pipeline outputs
#   make ml-test                   # tests/ml
#
# Python: set PY to an interpreter with requirements-ml.txt installed. (A venv
# cannot live inside this folder: its name contains ';', which venv refuses.)

PY ?= python
DATA ?= $(if $(wildcard data-products/index.json),data-products,data-products/demo)
OUT ?= data-products/ml
APP_ML ?= public/data/ml

.PHONY: ml ml-demo-inputs ml-test ml-copy

ml:
	@test -f "$(DATA)/index.json" || $(MAKE) ml-demo-inputs DATA="$(DATA)"
	$(PY) -m src.compute.ml.run --data "$(DATA)" --out "$(OUT)"
	$(MAKE) ml-copy

ml-demo-inputs:
	node scripts/generate-demo-data.ts "$(DATA)"
	node scripts/export-ml-demo-inputs.ts "$(DATA)"

ml-copy:
	node scripts/copy-ml.mjs "$(OUT)" "$(APP_ML)"

ml-test:
	$(PY) -m pytest tests/ml -q

# ---------------------------------------------------------------------------
# Real NASA data (docs/real_data_plan.md). FIRMS_MAP_KEY in .env (cp .env.example .env).
#
#   make fetch                     FIRMS + POWER + EONET into data/raw/ (cached; re-runs download nothing new)
#   make fetch ARGS=--dry-run      planned number of FIRMS calls, nothing downloaded
#   make real                      fetch -> pipeline -> contract -> ml -> seam -> EONET check -> report
#   make snapshot                  data-products/ -> public/data/ ("source": "cache"); the app then uses it
#   make ingest-test               tests/ingest

.PHONY: fetch real snapshot ingest-test

fetch:
	$(PY) -m src.ingest fetch $(ARGS)

real:
	$(PY) -m src.ingest fetch
	$(PY) -m src.compute.pipeline
	node scripts/export-contract.ts data/stage/base data-products
	-$(PY) -m src.compute.ml.run --data data-products --out data-products/ml
	$(PY) -m src.compute.seam --data data-products
	$(PY) -m src.ingest validate-eonet
	$(PY) -m src.compute.data_report --data data-products

snapshot:
	node scripts/snapshot.mjs data-products public/data

ingest-test:
	$(PY) -m pytest tests/ingest -q
