#!/usr/bin/env bash
# Laptop staging only: make the expense web apps and App API point at the staging
# hostnames. Run on the laptop as root:
#   FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json \
#   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<repo variable of the same name> \
#     staging-web.sh IMAGE_TAG BUILD_CONTEXT
# IMAGE_TAG   the tag the laptop already runs (/opt/expense-tax-management/app/deployed-image-tag)
# BUILD_CONTEXT  checkout of that commit's expense-tax-management/ directory
# Env origins come from the Firestore profile expense-tax-management/staging, layered after
# production. Web images are built here (never pushed). A normal CI deploy with target=laptop
# recreates these services from the production images; re-run this script afterwards.
set -Eeuo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TAG=${1:?usage: staging-web.sh IMAGE_TAG BUILD_CONTEXT}
CONTEXT=${2:?usage: staging-web.sh IMAGE_TAG BUILD_CONTEXT}
[[ "$TAG" =~ ^[0-9a-f]{40}$ ]] || { echo "IMAGE_TAG must be a 40-hex SHA" >&2; exit 1; }
: "${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:?set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}"

for app in capture office; do
  docker build -f "$CONTEXT/frontend/$app-web/Dockerfile" \
    --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" \
    --build-arg NEXT_PUBLIC_APP_API_URL=https://staging-expense-api.tobytran.dev \
    -t "family-app-staging/expense-tax-$app-web:$TAG" "$CONTEXT"
done

export IMAGE_TAG=$TAG
"$HERE/family_config.py" run expense-tax-management/production expense-tax-management/staging \
  --env-file-var STAGING_ENV_FILE -- bash -c '
    docker compose --project-name expense-tax-production --env-file "$STAGING_ENV_FILE" \
      -f "$0/docker-compose.yml" -f "$0/docker-compose.mailbox.yml" -f "$0/docker-compose.staging.yml" \
      up -d --no-deps app-api mailbox-broker capture-web office-web' "$HERE"
