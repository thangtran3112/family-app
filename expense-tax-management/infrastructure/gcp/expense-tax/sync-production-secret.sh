#!/usr/bin/env bash
set -euo pipefail
set -o pipefail
umask 077

PROJECT_ID="expense-tax-tobytran-2026"
SECRET_ID="expense-tax-production-env"
DATABASE_ENV_PATH="${DATABASE_ENV_PATH:-.keys/ovh/postgres-vps.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_MODULE="$(cd "$SCRIPT_DIR/../../../scripts/lib" && pwd)/production-secret-bundle.mjs"
TEMP_DIR="$(mktemp -d)"
BUNDLE_FILE="$TEMP_DIR/bundle.env"
CURRENT_FILE="$TEMP_DIR/current.env"
VERSIONS_FILE="$TEMP_DIR/versions.json"
VERIFY_FILE="$TEMP_DIR/verify.env"
API_ENV_FILE="$TEMP_DIR/api.env"

cleanup() {
  rm -f "$BUNDLE_FILE" "$CURRENT_FILE" "$VERSIONS_FILE" "$VERIFY_FILE" "$API_ENV_FILE"
  rmdir "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT
chmod 700 "$TEMP_DIR"

if [[ ! -f "$DATABASE_ENV_PATH" ]]; then
  echo "database env file not found: $DATABASE_ENV_PATH" >&2
  exit 1
fi

gcloud secrets versions list "$SECRET_ID" --project="$PROJECT_ID" --format=json > "$VERSIONS_FILE"
CURRENT_VERSION_IDS="$(env -i PATH="$PATH" VERSIONS_FILE="$VERSIONS_FILE" BUNDLE_MODULE="$BUNDLE_MODULE" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const { activeVersionIds } = await import(process.env.BUNDLE_MODULE);
const versions = JSON.parse(readFileSync(process.env.VERSIONS_FILE, "utf8"));
for (const version of activeVersionIds(versions)) console.log(version);
NODE
)"
if [[ -n "$CURRENT_VERSION_IDS" ]]; then
  if ! gcloud secrets versions access latest --secret="$SECRET_ID" --project="$PROJECT_ID" > "$CURRENT_FILE"; then
    echo "current secret access failed; refusing destructive rotation" >&2
    exit 1
  fi
  chmod 600 "$CURRENT_FILE"
  CURRENT_ENV_PATH="$CURRENT_FILE"
else
  echo "only proven no-version state: no non-destroyed secret version"
  rm -f "$CURRENT_FILE"
  CURRENT_ENV_PATH=""
fi

API_ENV_FILE="$API_ENV_FILE" zsh -dfic '
  # Startup files are user-controlled; discard all startup output before loading them.
  set +x
  exec >/dev/null 2>&1
  source ~/.zshrc
  set +x
  : "${OPENAI_API_KEY:?OPENAI_API_KEY must be set in ~/.zshrc}"
  : "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set in ~/.zshrc}"
  umask 077
  # Export only required API-key variables into protected builder input.
  printf "export OPENAI_API_KEY=%q\\nexport OPENROUTER_API_KEY=%q\\n" \
    "$OPENAI_API_KEY" "$OPENROUTER_API_KEY" > "$API_ENV_FILE"
'
chmod 600 "$API_ENV_FILE"

env -i PATH="$PATH" HOME="$HOME" \
  API_ENV_FILE="$API_ENV_FILE" \
  DATABASE_ENV_PATH="$DATABASE_ENV_PATH" \
  CURRENT_ENV_PATH="$CURRENT_ENV_PATH" \
  VERSIONS_FILE="$VERSIONS_FILE" \
  BUNDLE_MODULE="$BUNDLE_MODULE" \
  BUNDLE_FILE="$BUNDLE_FILE" \
  zsh -dfc '
  source "$API_ENV_FILE"
  export OPENAI_API_KEY OPENROUTER_API_KEY \
    CLERK_APP_MACHINE_SECRET_KEY CLERK_FOUNDRY_MACHINE_SECRET_KEY
  node --input-type=module <<"NODE"
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
const { buildProductionBundle, activeVersionIds } = await import(process.env.BUNDLE_MODULE);

const currentEnv = process.env.CURRENT_ENV_PATH
  ? readFileSync(process.env.CURRENT_ENV_PATH, "utf8")
  : undefined;
const bundle = buildProductionBundle({
  shellEnv: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    CLERK_APP_MACHINE_SECRET_KEY: process.env.CLERK_APP_MACHINE_SECRET_KEY,
    CLERK_FOUNDRY_MACHINE_SECRET_KEY: process.env.CLERK_FOUNDRY_MACHINE_SECRET_KEY,
  },
  databaseEnv: readFileSync(process.env.DATABASE_ENV_PATH, "utf8"),
  currentEnv,
});
writeFileSync(process.env.BUNDLE_FILE, bundle, { mode: 0o600 });
chmodSync(process.env.BUNDLE_FILE, 0o600);
const versions = JSON.parse(readFileSync(process.env.VERSIONS_FILE, "utf8"));
console.log(JSON.stringify({ activeVersionIds: activeVersionIds(versions) }));
NODE
'

NEW_VERSION="$(gcloud secrets versions add "$SECRET_ID" --project="$PROJECT_ID" --data-file="$BUNDLE_FILE" --format='value(name)' | awk -F/ '{print $NF}')"
if [[ -z "$NEW_VERSION" ]]; then
  echo "Secret Manager did not return new version ID" >&2
  exit 1
fi

gcloud secrets versions access "$NEW_VERSION" --secret="$SECRET_ID" \
  --project="$PROJECT_ID" > "$VERIFY_FILE"
chmod 600 "$VERIFY_FILE"
EXPECTED_HASH="$(shasum -a 256 "$BUNDLE_FILE" | awk '{print $1}')"
ACTUAL_HASH="$(shasum -a 256 "$VERIFY_FILE" | awk '{print $1}')"
if [[ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]]; then
  echo "Secret Manager payload hash mismatch" >&2
  exit 1
fi
echo "uploaded version $NEW_VERSION; sha256 $ACTUAL_HASH"

gcloud secrets versions list "$SECRET_ID" --project="$PROJECT_ID" --format=json > "$VERSIONS_FILE"
OLD_VERSIONS="$(env -i PATH="$PATH" VERSIONS_FILE="$VERSIONS_FILE" BUNDLE_MODULE="$BUNDLE_MODULE" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const { activeVersionIds } = await import(process.env.BUNDLE_MODULE);
const versions = JSON.parse(readFileSync(process.env.VERSIONS_FILE, "utf8"));
for (const version of activeVersionIds(versions)) console.log(version);
NODE
)"
destroy_failures=()
while IFS= read -r version; do
  [[ -z "$version" || "$version" == "$NEW_VERSION" ]] && continue
  if ! gcloud secrets versions destroy "$version" --secret="$SECRET_ID" --project="$PROJECT_ID" --quiet; then
    destroy_failures+=("$version")
  fi
done <<< "$OLD_VERSIONS"

gcloud secrets versions list "$SECRET_ID" --project="$PROJECT_ID" --format=json > "$VERSIONS_FILE"
POSTCONDITION="$(env -i PATH="$PATH" VERSIONS_FILE="$VERSIONS_FILE" BUNDLE_MODULE="$BUNDLE_MODULE" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const { activeVersionIds } = await import(process.env.BUNDLE_MODULE);
const versions = JSON.parse(readFileSync(process.env.VERSIONS_FILE, "utf8"));
const ids = activeVersionIds(versions);
console.log(`${ids.length}:${ids[0] ?? ""}`);
NODE
)"

if (( ${#destroy_failures[@]} > 0 )); then
  printf 'failed to destroy old secret versions: %s\n' "${destroy_failures[*]}" >&2
fi
if [[ "$POSTCONDITION" != "1:$NEW_VERSION" ]]; then
  echo "postcondition failed: expected exactly one non-destroyed version equal to new version $NEW_VERSION; got $POSTCONDITION" >&2
  exit 1
fi
if (( ${#destroy_failures[@]} > 0 )); then
  exit 1
fi
echo "postcondition verified: exactly one non-destroyed version equals $NEW_VERSION"
