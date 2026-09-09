import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.resolve(appRoot, "../.github/workflows/expense-tax-ci.yml");
const raw = await readFile(workflowPath, "utf8");
const parsed = YAML.parse(raw);

for (const job of ["quality", "integration", "no-deploy"]) {
  if (!parsed.jobs?.[job]) throw new Error(`Missing CI job: ${job}`);
}
for (const required of [
  "pnpm contracts:check",
  "pnpm --filter @expense-tax/contracts build",
  "pnpm ci:lint",
  "pnpm ci:typecheck",
  "pnpm ci:test",
  "pnpm ci:build",
  "pnpm ci:python:lint",
  "pnpm ci:python:test",
  "pnpm verify:phase-0n",
  "PHASE_0N_INTEGRATION",
  "uv sync --frozen",
  "permissions:\n  contents: read",
]) {
  if (!raw.includes(required)) throw new Error(`Missing CI requirement: ${required}`);
}

// Phase 1A must never mutate infrastructure. These strings are rejected
// anywhere in the workflow (including env/steps), not merely by convention.
for (const forbidden of [
  "google-github-actions/auth",
  "gcloud ",
  "terraform apply",
  "kubectl ",
  "ssh ",
  "VPS_SSH_KEY",
  "secrets.",
  "docker push",
]) {
  if (raw.includes(forbidden)) throw new Error(`Deployment gate violated by: ${forbidden}`);
}
console.log("PASS GitHub Actions syntax/shape and no-deploy gate");
