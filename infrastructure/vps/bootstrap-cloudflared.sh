#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bootstrap-cloudflared.sh --host HOST --user USER --key PATH
                                --ssh-port PORT --tunnel-token-file PATH
EOF
}

HOST=""
USER_NAME=""
SSH_KEY=""
SSH_PORT=""
TOKEN_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --key) SSH_KEY="$2"; shift 2 ;;
    --ssh-port) SSH_PORT="$2"; shift 2 ;;
    --tunnel-token-file) TOKEN_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

for required in HOST USER_NAME SSH_KEY SSH_PORT TOKEN_FILE; do
  if [[ -z "${!required}" ]]; then
    echo "Missing required argument for ${required}" >&2
    usage
    exit 1
  fi
done

[[ -f "$TOKEN_FILE" ]] || { echo "Tunnel token file not found" >&2; exit 1; }
if TOKEN_MODE="$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null)"; then
  :
else
  TOKEN_MODE="$(stat -f '%Lp' "$TOKEN_FILE")"
fi
[[ "$TOKEN_MODE" == "600" ]] || {
  echo "Tunnel token file must have mode 0600" >&2
  exit 1
}
[[ -r "$SSH_KEY" ]] || { echo "SSH key is not readable" >&2; exit 1; }

SSH_OPTIONS=(-p "$SSH_PORT" -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
REMOTE="${USER_NAME}@${HOST}"

ssh_run() {
  ssh "${SSH_OPTIONS[@]}" "$REMOTE" "$@"
}

echo "Installing cloudflared on ${REMOTE}"
ssh_run 'set -Eeuo pipefail
  required_version=2025.4.0
  version_at_least() {
    local current required
    local current_major current_minor current_patch
    local required_major required_minor required_patch
    current="$1"
    required="$2"
    IFS=. read -r current_major current_minor current_patch <<< "$current"
    IFS=. read -r required_major required_minor required_patch <<< "$required"
    if (( current_major > required_major )); then return 0; fi
    if (( current_major < required_major )); then return 1; fi
    if (( current_minor > required_minor )); then return 0; fi
    if (( current_minor < required_minor )); then return 1; fi
    (( current_patch >= required_patch ))
  }

  installed_version=""
  if command -v cloudflared >/dev/null 2>&1; then
    installed_version="$(cloudflared --version 2>/dev/null | sed -nE 's/[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n1)"
  fi

  if [[ -z "$installed_version" ]] || ! version_at_least "$installed_version" "$required_version"; then
    sudo install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
      | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
      | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
    sudo apt-get update
    sudo apt-get install -y cloudflared
  fi

  installed_version="$(cloudflared --version 2>/dev/null | sed -nE 's/[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n1)"
  version_at_least "$installed_version" "$required_version" || {
    echo "cloudflared ${required_version} or newer is required; found ${installed_version:-unknown}" >&2
    exit 1
  }'

ssh "${SSH_OPTIONS[@]}" "$REMOTE" 'set -Eeuo pipefail
  sudo install -d -m 0755 /etc/cloudflared
  sudo install -o root -g root -m 0600 /dev/stdin /etc/cloudflared/expense-tax-tunnel.token
  sudo tee /etc/systemd/system/expense-tax-cloudflared.service >/dev/null <<"UNIT"
[Unit]
Description=Expense Tax Cloudflare Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel run --token-file /etc/cloudflared/expense-tax-tunnel.token
Restart=on-failure
RestartSec=5s
User=root

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now expense-tax-cloudflared.service
  sudo systemctl restart expense-tax-cloudflared.service
  sudo systemctl is-active --quiet expense-tax-cloudflared.service
  echo "cloudflared service active"' < "$TOKEN_FILE"
