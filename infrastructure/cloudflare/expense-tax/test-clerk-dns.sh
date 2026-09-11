#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLERK_TF="$SCRIPT_DIR/clerk_dns.tf"
MAIN_TF="$SCRIPT_DIR/main.tf"

test -f "$CLERK_TF"

for record in \
  'clerk.tobytran.dev|frontend-api.clerk.services' \
  'accounts.tobytran.dev|accounts.clerk.services' \
  'clkmail.tobytran.dev|mail.isbd4mdbk2ld.clerk.services' \
  'clk._domainkey.tobytran.dev|dkim1.isbd4mdbk2ld.clerk.services' \
  'clk2._domainkey.tobytran.dev|dkim2.isbd4mdbk2ld.clerk.services'; do
  name="${record%%|*}"
  target="${record#*|}"
  grep -Fq "\"$name\"" "$CLERK_TF"
  grep -Fq "\"$target\"" "$CLERK_TF"
done

grep -Fq 'resource "cloudflare_dns_record" "clerk"' "$CLERK_TF"
grep -Fq 'proxied = false' "$CLERK_TF"
grep -Fq 'resource "cloudflare_dns_record" "tunnel"' "$MAIN_TF"
grep -Fq 'proxied = true' "$MAIN_TF"

echo "Clerk DNS static checks passed"
