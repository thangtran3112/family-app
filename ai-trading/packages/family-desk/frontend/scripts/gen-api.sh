#!/usr/bin/env bash
set -euo pipefail

frontend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend_dir="$(cd "$frontend_dir/../backend" && pwd)"
mkdir -p "$frontend_dir/lib/api"

openapi_tmp="$frontend_dir/lib/api/openapi.json.tmp"
trap 'rm -f "$openapi_tmp"' EXIT
(
  cd "$backend_dir"
  uv run --locked python -m ai_trading.api.openapi_dump
) > "$openapi_tmp"
mv "$openapi_tmp" "$frontend_dir/lib/api/openapi.json"

(
  cd "$frontend_dir"
  pnpm exec openapi-typescript lib/api/openapi.json -o lib/api/openapi.d.ts
)
