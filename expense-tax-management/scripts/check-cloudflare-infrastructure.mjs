import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const appRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = join(appRoot, "..");
const moduleRoot = join(repoRoot, "infrastructure/cloudflare/expense-tax");
const read = (file) => readFileSync(join(moduleRoot, file), "utf8");
const main = read("main.tf");
const readme = read("README.md");
const state = read("bootstrap-state.sh");
const vps = readFileSync(join(repoRoot, "infrastructure/vps/bootstrap-cloudflared.sh"), "utf8");
const workflowRaw = readFileSync(join(repoRoot, ".github/workflows/expense-tax-cloudflare.yml"), "utf8");
const workflow = YAML.parse(workflowRaw);
const failures = [];
const pullRequestJob = workflow.jobs?.validate;
const planJob = workflow.jobs?.plan;
const applyJob = workflow.jobs?.apply;

function includes(source, value, label = value) {
  if (!source.includes(value)) failures.push(`missing: ${label}`);
}

function excludes(source, value, label = value) {
  if (source.includes(value)) failures.push(`forbidden: ${label}`);
}

includes(main, 'version = ">= 5.8.2, < 6.0.0"');
includes(main, 'backend "gcs"');
includes(main, 'prefix = "cloudflare/expense-tax"');
includes(main, 'config_src = "cloudflare"');
includes(main, 'service  = "http://127.0.0.1:7301"');
includes(main, 'service  = "http://127.0.0.1:8100"');
includes(main, 'service  = "http://127.0.0.1:7302"');
includes(main, 'service  = "http://127.0.0.1:7303"');
includes(main, 'service = "http_status:404"');
includes(main, 'type    = "CNAME"');
includes(main, 'proxied = true');
includes(main, '.cfargotunnel.com');
excludes(main, "expense-clerk", "Clerk hostname in tunnel Terraform");
includes(readme, "Account: **Cloudflare Tunnel Edit**");
includes(readme, "Zone: **DNS Edit**");
includes(readme, "expense-clerk.tobytran.dev");
includes(readme, "DNS-only");
includes(vps, "TOKEN_MODE");
includes(vps, "0600");
includes(vps, "stat -c '%a'");
includes(vps, "stat -f '%Lp'");
includes(vps, "2025.4.0");
includes(vps, "apt-get install -y cloudflared");
includes(vps, "--token-file /etc/cloudflared/expense-tax-tunnel.token");
includes(vps, "pkg.cloudflare.com/cloudflared");
excludes(vps, "cat \"$TOKEN_FILE\"", "token content command substitution");

if (!pullRequestJob) failures.push("missing: unprivileged PR validation job");
if (!planJob || !applyJob) failures.push("missing: plan/apply jobs");
if (pullRequestJob?.permissions?.["id-token"] !== "none") {
  failures.push("PR validation must not receive OIDC permission");
}
if (pullRequestJob?.environment) failures.push("PR validation must not use production environment");
if (pullRequestJob?.env?.TF_VAR_cloudflare_api_token) {
  failures.push("PR validation must not receive Cloudflare API token");
}
const pullRequestRun = pullRequestJob?.steps?.find((step) => String(step.name).includes("Terraform init"))?.run ?? "";
includes(pullRequestRun, "terraform init -backend=false", "PR Terraform init with backend disabled");
if (planJob?.environment !== "production") failures.push("trusted plan must use production environment");
if (planJob?.permissions?.["id-token"] !== "write") {
  failures.push("trusted plan must receive OIDC permission");
}
if (!String(planJob?.if).includes("github.ref == 'refs/heads/main'")) {
  failures.push("trusted plan must require refs/heads/main");
}
if (!String(planJob?.if).includes("github.event_name == 'push'") || !String(planJob?.if).includes("workflow_dispatch")) {
  failures.push("trusted plan must allow only main push or manual dispatch");
}
if (applyJob?.environment !== "production") failures.push("apply must use production environment");
if (applyJob?.permissions?.["id-token"] !== "write") {
  failures.push("apply must receive OIDC permission");
}
includes(workflowRaw, "google-github-actions/auth@v3");
includes(workflowRaw, "hashicorp/setup-terraform@v3");
includes(workflowRaw, "terraform init");
includes(workflowRaw, "terraform validate");
includes(workflowRaw, "terraform plan");
includes(workflowRaw, "terraform apply");
includes(workflowRaw, "environment: production");
includes(workflowRaw, "inputs.apply == true");
includes(workflowRaw, "-backend=false", "PR validation backend disabled");
includes(state, "verify_bucket_project", "state bucket project verification");
includes(state, "daysSinceNoncurrentTime", "state noncurrent lifecycle policy");
excludes(workflowRaw, "expense-tax-management/deploy/production", "application deployment in Cloudflare workflow");
excludes(workflowRaw, "docker push", "container deployment in Cloudflare workflow");

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Cloudflare infrastructure static checks passed");
}
