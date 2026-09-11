import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const syncScript = join(
  projectRoot,
  "infrastructure/gcp/expense-tax/sync-production-secret.sh",
);
const bootstrapScript = join(
  projectRoot,
  "infrastructure/gcp/expense-tax/bootstrap.sh",
);

function commandBlocks(source, prefix) {
  const lines = source.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trimStart().startsWith(prefix)) continue;
    const block = [lines[index].trim()];
    while (block.at(-1).endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      block.push(lines[index].trim());
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

const mockGcloud = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$1:$2:$3" in
  secrets:versions:list)
    count="$(wc -l < "$LIST_COUNT")"
    printf '%s\\n' "$count" > "$LIST_COUNT"
    if [[ "$MOCK_MODE" == "access-failure" ]]; then
      printf '%s\\n' '[{"name":"projects/test/secrets/expense-tax-production-env/versions/1","state":"ENABLED"}]'
    else
      if [[ "$count" == "0" ]]; then
        printf '%s\\n' '[{"name":"projects/test/secrets/expense-tax-production-env/versions/1","state":"ENABLED"},{"name":"projects/test/secrets/expense-tax-production-env/versions/2","state":"DISABLED"}]'
      else
        printf '%s\\n' '[{"name":"projects/test/secrets/expense-tax-production-env/versions/1","state":"ENABLED"},{"name":"projects/test/secrets/expense-tax-production-env/versions/2","state":"DISABLED"},{"name":"projects/test/secrets/expense-tax-production-env/versions/3","state":"ENABLED"}]'
      fi
    fi
    ;;
  secrets:versions:access)
    if [[ "$4" == "latest" && "$MOCK_MODE" == "access-failure" ]]; then
      printf '%s\\n' 'permission denied' >&2
      exit 23
    fi
    cat "$MOCK_PAYLOAD"
    ;;
  secrets:versions:add)
    for arg in "$@"; do
      [[ "$arg" == --data-file=* ]] && cp "\${arg#--data-file=}" "$MOCK_PAYLOAD"
    done
    printf '%s\\n' 'projects/test/secrets/expense-tax-production-env/versions/3'
    ;;
  secrets:versions:destroy)
    [[ "$4" == "1" && "$MOCK_MODE" == "destroy-failure" ]] && exit 31
    ;;
esac
`;

function runSync(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(syncScript, [], { cwd: projectRoot, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function fixture(mode) {
  const root = await mkdtemp(join(tmpdir(), "phase-1b-gcp-test-"));
  const bin = join(root, "gcloud");
  await writeFile(bin, mockGcloud);
  await chmod(bin, 0o700);
  await writeFile(join(root, ".zshrc"), [
    "set -x",
    "printf '%s\\n' \"startup-openai=$OPENAI_API_KEY\"",
    "export OPENAI_API_KEY=test-openai",
    "export OPENROUTER_API_KEY=test-openrouter",
    "export CLERK_APP_MACHINE_SECRET_KEY=test-clerk-app",
    "export CLERK_FOUNDRY_MACHINE_SECRET_KEY=test-clerk-foundry",
    "printf '%s\\n' \"startup-openrouter=$OPENROUTER_API_KEY\"",
  ].join("\n"));
  const database = join(root, "database.env");
  await writeFile(database, [
    "APP_DATABASE_URL=postgresql://app@127.0.0.1:15432/expense_tax_db",
    "APP_MIGRATION_DATABASE_URL=postgresql://migrator@127.0.0.1:15432/expense_tax_db",
    "FOUNDRY_DATABASE_URL=postgresql://foundry@127.0.0.1:15432/expense_tax_db",
    "FOUNDRY_MIGRATION_DATABASE_URL=postgresql://foundry-migrator@127.0.0.1:15432/expense_tax_db",
  ].join("\n"));
  const log = join(root, "gcloud.log");
  const payload = join(root, "payload.env");
  await writeFile(join(root, "list.count"), "");
  await writeFile(payload, "");
  return {
    root,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      HOME: root,
      DATABASE_ENV_PATH: database,
      MOCK_LOG: log,
      MOCK_PAYLOAD: payload,
      LIST_COUNT: join(root, "list.count"),
      MOCK_MODE: mode,
    },
    log,
  };
}

describe("production secret sync behavior", () => {
  it("uses valid billing account identifier and rejects known typo", async () => {
    const bootstrap = await readFile(bootstrapScript, "utf8");

    expect(bootstrap).toContain('BILLING_ACCOUNT="013C6D-EEE26E-EAA1A1"');
    expect(bootstrap).not.toContain("013C6D-EEE26-EAA1A1");
  });

  it("validates WIF issuer at current gcloud provider schema path", async () => {
    const bootstrap = await readFile(bootstrapScript, "utf8");

    expect(bootstrap).toContain("provider.oidc?.issuerUri");
    expect(bootstrap).not.toContain("issuerUri: provider.issuerUri");
  });

  it("pins WIF condition and repository principal-set binding", async () => {
    const bootstrap = await readFile(bootstrapScript, "utf8");

    for (const claim of [
      "assertion.repository=='thangtran3112/family-app'",
      "assertion.ref=='refs/heads/main'",
      "assertion.workflow_ref=='thangtran3112/family-app/.github/workflows/expense-tax-deploy.yml@refs/heads/main'",
      "assertion.workflow_ref=='thangtran3112/family-app/.github/workflows/expense-tax-cloudflare.yml@refs/heads/main'",
      "assertion.environment=='production'",
    ]) {
      expect(bootstrap).toContain(claim);
    }
    expect(bootstrap).toContain("PRINCIPAL_SET");
    expect(bootstrap).toContain("attribute.repository/${REPOSITORY}");
    expect(bootstrap).not.toContain("PRINCIPAL_SUBJECT");
    expect(bootstrap).not.toContain('--member="$PRINCIPAL_SUBJECT"');
    expect(bootstrap).toContain("gcloud iam service-accounts get-iam-policy");
    expect(bootstrap).toContain("WIF service-account binding drift");
  });

  it("binds exact IAM action, role, and member tuples", async () => {
    const bootstrap = await readFile(bootstrapScript, "utf8");
    const serviceAccountBlocks = commandBlocks(bootstrap, "gcloud iam service-accounts ")
      .filter((block) => block.includes("iam-policy-binding"));
    expect(serviceAccountBlocks).toHaveLength(2);
    expect(serviceAccountBlocks).toEqual(expect.arrayContaining([
      expect.stringMatching(/remove-iam-policy-binding[\s\S]*--role="roles\/iam\.workloadIdentityUser"[\s\S]*--member="principal:\/\/iam\.googleapis\.com\/projects\/\$\{PROJECT_NUMBER\}\/locations\/global\/workloadIdentityPools\/\$\{POOL_ID\}\/subject\/repo:\$\{REPOSITORY\}:environment:production"/u),
      expect.stringMatching(/add-iam-policy-binding[\s\S]*--role="roles\/iam\.workloadIdentityUser"[\s\S]*--member="\$PRINCIPAL_SET"/u),
    ]));
    expect(commandBlocks(bootstrap, "gcloud secrets add-iam-policy-binding ")).toEqual([
      expect.stringMatching(/--role="roles\/secretmanager\.secretAccessor"[\s\S]*--member="serviceAccount:\$\{SERVICE_ACCOUNT_EMAIL\}"/u),
    ]);
  });

  it("does not leak startup output or API-key values", async () => {
    const test = await fixture("success");
    const result = await runSync(test.env);

    expect(result.stdout).not.toContain("test-openai");
    expect(result.stdout).not.toContain("test-openrouter");
    expect(result.stderr).not.toContain("test-openai");
    expect(result.stderr).not.toContain("test-openrouter");
  });

  it("aborts on current-version access failure before uploading", async () => {
    const test = await fixture("access-failure");
    const result = await runSync(test.env);
    const log = await readFile(test.log, "utf8");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing destructive rotation");
    expect(log).not.toContain("versions add");
  });

  it("attempts every old destruction and rejects a failed postcondition", async () => {
    const test = await fixture("destroy-failure");
    const result = await runSync(test.env);
    const log = await readFile(test.log, "utf8");

    expect(result.status).not.toBe(0);
    expect(log, result.stderr).toContain("versions destroy 1");
    expect(log).toContain("versions destroy 2");
    expect(result.stderr).toContain("postcondition failed");
  });
});
