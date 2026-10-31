#!/usr/bin/env bash
# Transitional shim (0001b-1): expense-tax-management/package.json still runs this path.
# 0001b-2 repoints the expense references to infrastructure/host/ and deletes infrastructure/vps/.
exec bash "$(dirname "${BASH_SOURCE[0]}")/../host/test-bootstrap.sh" "$@"
