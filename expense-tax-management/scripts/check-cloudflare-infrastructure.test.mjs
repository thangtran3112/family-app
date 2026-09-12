import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLY_CONDITION,
  TRUSTED_PLAN_CONDITION,
  conditionIsExactly,
} from "./check-cloudflare-infrastructure.mjs";

const repoRoot = join(process.cwd(), "..");
const main = readFileSync(join(repoRoot, "infrastructure/cloudflare/expense-tax/main.tf"), "utf8");
const workflow = readFileSync(join(repoRoot, ".github/workflows/expense-tax-cloudflare.yml"), "utf8");
const vps = readFileSync(join(repoRoot, "infrastructure/vps/bootstrap-cloudflared.sh"), "utf8");
const state = readFileSync(join(repoRoot, "infrastructure/cloudflare/expense-tax/bootstrap-state.sh"), "utf8");
const cloudflareBootstrap = readFileSync(
  join(repoRoot, "expense-tax-management/infrastructure/gcp/expense-tax/bootstrap-cloudflare.sh"),
  "utf8",
);
const legacyServiceAccountId = ["expense-tax-cloudflare", "terraform"].join("-");

describe("Cloudflare workflow condition checks", () => {
  it("accepts equivalent whitespace in trusted plan condition", () => {
    expect(conditionIsExactly(
      "(github.event_name == 'push' && github.ref == 'refs/heads/main') ||\n" +
        "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
      TRUSTED_PLAN_CONDITION,
    )).toBe(true);
  });

  it("rejects additional trusted plan branches", () => {
    expect(conditionIsExactly(
      `${TRUSTED_PLAN_CONDITION} || github.event_name == 'schedule'`,
      TRUSTED_PLAN_CONDITION,
    )).toBe(false);
  });

  it("requires manual apply and explicit approval on main", () => {
    expect(conditionIsExactly(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.apply == true",
      APPLY_CONDITION,
    )).toBe(true);
    expect(conditionIsExactly(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
      APPLY_CONDITION,
    )).toBe(false);
  });

  it("applies the reviewed plan artifact and uses the dedicated identity", () => {
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("retention-days: 1");
    expect(workflow).toContain("actions/download-artifact@v4");
    expect(workflow).toContain("terraform apply -auto-approve tfplan");
    expect(workflow).toContain("GCP_CLOUDFLARE_WORKLOAD_IDENTITY_PROVIDER");
    expect(workflow).toContain("GCP_CLOUDFLARE_SERVICE_ACCOUNT");
    expect(workflow).not.toContain("terraform apply -auto-approve\n");
  });

  it("requires pinned SSH host keys and dedicated state identity", () => {
    expect(vps).toContain("--known-hosts-file");
    expect(vps).toContain("UserKnownHostsFile");
    expect(vps).toContain("StrictHostKeyChecking=yes");
    expect(vps).not.toContain("accept-new");
    expect(state).toContain("CLOUDFLARE_TERRAFORM_SERVICE_ACCOUNT");
    expect(state).toContain("expense-tax-cf-terraform@expense-tax-tobytran-2026.iam.gserviceaccount.com");
    expect(state).not.toContain(legacyServiceAccountId);
    expect(state).toContain("remove-iam-policy-binding");
    expect(cloudflareBootstrap).toContain('SERVICE_ACCOUNT_ID="expense-tax-cf-terraform"');
    expect(cloudflareBootstrap).not.toContain(legacyServiceAccountId);
    expect(cloudflareBootstrap).toContain("expense-tax-cloudflare.yml@refs/heads/main");
    expect(cloudflareBootstrap).not.toContain("secretmanager.secretAccessor");
  });

  it("routes guarded Foundry API paths before the generic Foundry web route", () => {
    const guardedFoundryRoute = [
      "        hostname = var.foundry_hostname",
      "        path     = \"/internal/v1/*\"",
      "        service  = \"http://127.0.0.1:8200\"",
    ].join("\n");
    const genericFoundryRoute = [
      "        hostname = var.foundry_hostname",
      "        service  = \"http://127.0.0.1:7303\"",
    ].join("\n");

    expect(main).toContain(guardedFoundryRoute);
    expect(main.indexOf(guardedFoundryRoute)).toBeLessThan(main.indexOf(genericFoundryRoute));
  });

  it("verifies exact state bucket membership in requested project before mutations", () => {
    expect(state).toContain("gcloud storage buckets list --project=\"$PROJECT_ID\" --format='value(name)'");
    expect(state).toMatch(/grep -Fqx \"\$BUCKET\"/);
    expect(state).not.toContain("gcloud storage buckets describe \"gs://${BUCKET}\" --format='value(projectNumber)'");
    expect(state.indexOf("verify_bucket_project")).toBeLessThan(state.indexOf("--versioning"));
    expect(state.indexOf("verify_bucket_project")).toBeLessThan(state.indexOf("add-iam-policy-binding"));
  });
});
