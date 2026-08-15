#!/usr/bin/env bash
# Renderer E2E: fresh demo data, then the app runs test/renderer-spec.js
# in-page (see CTTC_TEST in main.js). Exit code 0 = all assertions passed.
set -euo pipefail
cd "$(dirname "$0")/.."
# demo/generate_demo.py has no third-party dependencies of its own --
# --project server-logsump just borrows an existing, already-`uv sync`'d
# venv to run it under (app/server, the old dependency-bearing project this
# used to point at, was decommissioned -- see
# .claude/plans/sprightly-stirring-blum.md's Phase 10).
env -u VIRTUAL_ENV uv run --project server-logsump demo/generate_demo.py --out demo/data >/dev/null
exec env -u ELECTRON_RUN_AS_NODE CTTC_TEST=test/renderer-spec.js \
  npx electron . demo/data/stats.jsonl demo/data/c3_api.log demo/data/c3_worker.log
