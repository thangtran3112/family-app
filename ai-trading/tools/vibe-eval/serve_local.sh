#!/bin/bash
# Start a local Vibe-Trading server from this checkout with the production profile's environment
# (Firestore `ai-trading/vibe-trading`, rendered by family_config.py) in a sandboxed home directory.
#
# usage: serve_local.sh PORT HOME_DIR VENV_DIR
# Stop it with: kill $(lsof -tiTCP:PORT -sTCP:LISTEN)
set -eu
PORT=${1:?port}
HOME_DIR=${2:?home dir}
VENV=${3:?venv dir}
ROOT=${ROOT:-$(git rev-parse --show-toplevel)}
mkdir -p "$HOME_DIR"
cd "$ROOT/ai-trading/packages/vibe-trading/agent"
exec python3 "$ROOT/common/config/family_config.py" run ai-trading/vibe-trading -- \
  env -u API_AUTH_KEY HOME="$HOME_DIR" VIBE_TRADING_HOME="$HOME_DIR/.vibe-trading" \
  PATH="$VENV/bin:$PATH" PYTHONPATH="$PWD" \
  python "$ROOT/ai-trading/deploy/upstream/vibe-trading/start-vibe.py" vibe-trading serve \
  --host 127.0.0.1 --port "$PORT"
