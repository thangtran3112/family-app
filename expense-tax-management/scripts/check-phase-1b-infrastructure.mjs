import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const infrastructureDir = join(scriptDir, "../infrastructure/gcp/expense-tax");
const bootstrap = readFileSync(join(infrastructureDir, "bootstrap.sh"), "utf8");
const sync = readFileSync(join(infrastructureDir, "sync-production-secret.sh"), "utf8");
const readme = readFileSync(join(infrastructureDir, "README.md"), "utf8");
const agents = readFileSync(join(scriptDir, "../AGENTS.md"), "utf8");

const failures = [];
function assertIncludes(source, expected, label = expected) {
  if (!source.includes(expected)) failures.push(`missing: ${label}`);
}
function assertExcludes(source, forbidden, label = forbidden) {
  if (source.includes(forbidden)) failures.push(`forbidden: ${label}`);
}
function assertBefore(source, first, second, label = `${first} before ${second}`) {
  if (source.indexOf(first) === -1 || source.indexOf(second) === -1 || source.indexOf(first) > source.indexOf(second)) {
    failures.push(`ordering: ${label}`);
  }
}

assertIncludes(bootstrap, 'PROJECT_ID="expense-tax-tobytran-2026"');
assertIncludes(bootstrap, 'BILLING_ACCOUNT="013C6D-EEE26E-EAA1A1"');
assertExcludes(bootstrap, "013C6D-EEE26-EAA1A1", "invalid billing account typo");
assertIncludes(bootstrap, 'SECRET_ID="expense-tax-production-env"');
assertIncludes(bootstrap, 'SERVICE_ACCOUNT_ID="expense-tax-github-deploy"');
assertIncludes(bootstrap, 'POOL_ID="expense-tax-github"');
assertIncludes(bootstrap, 'PROVIDER_ID="github"');
assertIncludes(bootstrap, 'REPOSITORY="thangtran3112/family-app"');
assertIncludes(bootstrap, "gcloud projects create");
assertIncludes(bootstrap, '--organization="$ORGANIZATION_ID"');
assertIncludes(bootstrap, "cloudresourcemanager.googleapis.com");
assertIncludes(bootstrap, "parent.id");
assertIncludes(bootstrap, "billingAccountName");
assertIncludes(bootstrap, "verify_project_contract");
assertIncludes(bootstrap, "billing projects link");
assertIncludes(bootstrap, "services enable");
assertIncludes(bootstrap, "iam service-accounts create");
assertIncludes(bootstrap, "iam workload-identity-pools create");
assertIncludes(bootstrap, "iam workload-identity-pools providers create-oidc");
assertIncludes(bootstrap, "assertion.repository=='thangtran3112/family-app'");
assertIncludes(bootstrap, "attributeMapping");
assertIncludes(bootstrap, 'provider.attributeMapping?.["google.subject"]');
assertIncludes(bootstrap, 'provider.attributeMapping?.["attribute.repository"]');
assertIncludes(bootstrap, "provider.oidc?.issuerUri");
assertExcludes(bootstrap, "issuerUri: provider.issuerUri", "incorrect gcloud provider issuer path");
assertIncludes(bootstrap, "issuerUri");
assertIncludes(bootstrap, "attributeCondition");
assertIncludes(bootstrap, "roles/iam.workloadIdentityUser");
assertIncludes(bootstrap, "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPOSITORY}");
assertIncludes(bootstrap, "roles/secretmanager.secretAccessor");
assertIncludes(bootstrap, "--format=json");
assertIncludes(bootstrap, "trap cleanup EXIT");
assertIncludes(bootstrap, 'rm -rf "$TEMP_DIR"');
assertBefore(bootstrap, "umask 077", 'TEMP_DIR="');
assertExcludes(bootstrap, "service-accounts keys create");
assertExcludes(sync, "--data-file=<(echo");
assertIncludes(sync, "secrets versions destroy");
assertIncludes(sync, "CURRENT_VERSION_IDS");
assertIncludes(sync, "only proven no-version state");
assertIncludes(sync, "if ! gcloud secrets versions access latest");
assertIncludes(sync, "refusing destructive rotation");
assertIncludes(sync, "destroy_failures");
assertIncludes(sync, "exactly one non-destroyed version");
assertIncludes(sync, "postcondition");
assertIncludes(sync, 'if [[ "$POSTCONDITION" != "1:$NEW_VERSION" ]]');
assertIncludes(sync, "set -o pipefail");
assertIncludes(sync, "activeVersionIds");
assertIncludes(sync, "buildProductionBundle");
assertIncludes(sync, "source ~/.zshrc");
assertIncludes(sync, "set +x");
assertIncludes(sync, "exec >/dev/null 2>&1");
assertIncludes(sync, "only required API-key variables");
assertIncludes(sync, "chmod 600");
assertIncludes(sync, "umask 077");
assertBefore(sync, "umask 077", 'TEMP_DIR="');
assertIncludes(sync, "trap cleanup EXIT");
assertIncludes(sync, 'rm -f "$BUNDLE_FILE" "$CURRENT_FILE" "$VERSIONS_FILE" "$VERIFY_FILE" "$API_ENV_FILE"');
assertIncludes(sync, ".keys/ovh/postgres-vps.env");
assertIncludes(readme, "expense-tax-tobytran-2026");
assertIncludes(readme, "expense-tax-production-env");
assertIncludes(readme, "013C6D-EEE26E-EAA1A1");
assertExcludes(readme, "013C6D-EEE26-EAA1A1", "invalid billing account typo");
assertIncludes(readme, "one non-destroyed version");
assertIncludes(bootstrap, ".keys/gcp/expense-tax-bootstrap-outputs.json");
assertIncludes(agents, "013C6D-EEE26E-EAA1A1");
assertExcludes(agents, "013C6D-EEE26-EAA1A1", "invalid billing account typo");

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Phase 1B infrastructure static checks passed");
}
