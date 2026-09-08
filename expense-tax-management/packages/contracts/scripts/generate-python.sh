#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
contracts_generated_root="${CONTRACTS_GENERATED_ROOT:-$repo_root/packages/contracts/generated}"
python_generated_root="${CONTRACTS_PYTHON_GENERATED_ROOT:-$repo_root/common/python/expense-contracts/src/expense_contracts/generated}"
schema_path="$contracts_generated_root/json-schema/internal-messages.schema.json"
output_path="$python_generated_root/internal_messages.py"

mkdir -p "$python_generated_root"
uv run --project "$repo_root/common/python/expense-contracts" datamodel-codegen \
  --input "$schema_path" \
  --input-file-type jsonschema \
  --output "$output_path" \
  --class-name JobReferenceV1 \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.13 \
  --target-pydantic-version 2 \
  --disable-timestamp \
  --extra-fields forbid \
  --use-double-quotes \
  --use-standard-collections
