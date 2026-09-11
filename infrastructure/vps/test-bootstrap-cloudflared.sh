#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash -n "$SCRIPT_DIR/bootstrap-cloudflared.sh"

echo "bootstrap-cloudflared.sh syntax valid"
