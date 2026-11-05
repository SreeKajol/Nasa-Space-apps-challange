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
