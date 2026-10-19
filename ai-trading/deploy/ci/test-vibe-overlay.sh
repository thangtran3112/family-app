#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

upstream=https://github.com/HKUDS/Vibe-Trading.git
[[ "$(git config -f .gitmodules --get submodule.ai-trading/packages/vibe-trading.url)" == "$upstream" ]]
[[ "$(git rev-parse :ai-trading/packages/vibe-trading)" == d71b28c743f783c5116efa56c87d17dfd8397c1f ]]
[[ "$(git -C ai-trading/packages/vibe-trading rev-parse HEAD)" == d71b28c743f783c5116efa56c87d17dfd8397c1f ]]
[[ -z "$(git -C ai-trading/packages/vibe-trading status --porcelain)" ]]
python3 ai-trading/deploy/upstream/vibe-trading/materialize.py --verify
