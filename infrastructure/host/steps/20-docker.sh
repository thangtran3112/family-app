#!/usr/bin/env bash
# Idempotent Docker Engine + Compose plugin install for a family-app VPS.
# Runs ON the target host as root/sudo. Safe to re-run.
set -euo pipefail

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "[docker] already installed: $(docker --version), $(docker compose version)"
  exit 0
fi

echo "[docker] installing Docker Engine + Compose plugin via get.docker.com"
curl -fsSL https://get.docker.com | sh

if ! id -nG "${SUDO_USER:-$USER}" 2>/dev/null | grep -qw docker; then
  echo "[docker] adding ${SUDO_USER:-$USER} to docker group (log out/in to take effect; sudo docker works immediately)"
  usermod -aG docker "${SUDO_USER:-$USER}" || true
fi

systemctl enable --now docker

echo "[docker] installed: $(docker --version)"
docker compose version
