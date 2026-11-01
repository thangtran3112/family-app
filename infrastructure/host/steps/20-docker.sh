#!/usr/bin/env bash
# Idempotent Docker Engine + Compose plugin install for a family-app host.
# Runs ON the target host as root/sudo. Safe to re-run.
#
# Optional env vars (unset = no data-root check, the original VPS behavior):
#   DOCKER_DATA_ROOT    - the directory Docker must use as its data-root (for example a
#                         dedicated partition mounted at /var/lib/docker). The step fails
#                         when `docker info` reports a different DockerRootDir.
#   DOCKER_DATA_MIN_GB  - with DOCKER_DATA_ROOT: the filesystem holding it must be at least
#                         this many GB (10^9 bytes, rounded down).
set -euo pipefail

install_docker() {
  echo "[docker] installing Docker Engine + Compose plugin via get.docker.com"
  curl -fsSL https://get.docker.com | sh

  if ! id -nG "${SUDO_USER:-$USER}" 2>/dev/null | grep -qw docker; then
    echo "[docker] adding ${SUDO_USER:-$USER} to docker group (log out/in to take effect; sudo docker works immediately)"
    usermod -aG docker "${SUDO_USER:-$USER}" || true
  fi

  systemctl enable --now docker

  echo "[docker] installed: $(docker --version)"
  docker compose version
}

# check_data_root: fail closed when Docker stores its images and volumes somewhere other than
# the directory (and filesystem size) the operator asked for.
check_data_root() {
  [[ -n "${DOCKER_DATA_ROOT:-}" ]] || return 0
  local actual min_gb="${DOCKER_DATA_MIN_GB:-0}" size_kb size_gb
  [[ "$min_gb" =~ ^[0-9]+$ ]] || { echo "[docker] ERROR: DOCKER_DATA_MIN_GB must be a whole number" >&2; return 1; }
  actual="$(docker info --format '{{.DockerRootDir}}')"
  if [[ "$actual" != "$DOCKER_DATA_ROOT" ]]; then
    echo "[docker] ERROR: Docker data-root is $actual, expected $DOCKER_DATA_ROOT (move it onto the dedicated partition before deploying)" >&2
    return 1
  fi
  if ((min_gb > 0)); then
    size_kb="$(df -Pk "$actual" | awk 'NR==2 {print $2}')"
    size_gb=$((size_kb * 1024 / 1000000000))
    if ((size_gb < min_gb)); then
      echo "[docker] ERROR: the filesystem holding $actual is ${size_gb} GB, need at least ${min_gb} GB" >&2
      return 1
    fi
  fi
  echo "[docker] data-root OK: $actual"
}

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "[docker] already installed: $(docker --version), $(docker compose version)"
else
  install_docker
fi

check_data_root
