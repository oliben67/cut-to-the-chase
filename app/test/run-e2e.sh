#!/usr/bin/env bash
# Renderer E2E: fresh demo data, then the app runs test/renderer-spec.js
# in-page (see CTTC_TEST in main.js). Exit code 0 = all assertions passed.
set -euo pipefail
cd "$(dirname "$0")/.."
env -u VIRTUAL_ENV uv run --project server demo/generate_demo.py --out demo/data >/dev/null
exec env -u ELECTRON_RUN_AS_NODE CTTC_TEST=test/renderer-spec.js \
  npx electron . demo/data/stats.jsonl demo/data/c3_api.log demo/data/c3_worker.log
