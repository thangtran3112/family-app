import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");

function runGate({ label, command, args, env = process.env }) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`FAIL ${label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const detail = result.signal
      ? `terminated by ${result.signal}`
      : `exited with status ${result.status}`;
    console.error(`FAIL ${label}: ${detail}`);
    process.exit(result.status ?? 1);
  }
  console.log(`PASS ${label}`);
}

function waitForReady(label, url) {
  console.log(`\n=== ${label} ===`);
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = spawnSync(
      "curl",
      ["--fail", "--silent", "--show-error", url],
      { cwd: repoRoot, env: process.env, encoding: "utf8" },
    );
    if (result.status === 0) {
      process.stdout.write(result.stdout + "\n");
      console.log(`PASS ${label}`);
      return;
    }
    if (attempt < 30) spawnSync("sleep", ["1"], { cwd: repoRoot });
  }
  console.error(`FAIL ${label}: timed out after 30 attempts`);
  process.exit(1);
}

runGate({
  label: "Phase 0I/0J/0J1/0K Wave A regression verification",
  command: "pnpm",
  args: ["verify:phase-0k:wave-a"],
  env: {
    ...process.env,
    PHASE_0I_INTEGRATION: "1",
    PHASE_0J_INTEGRATION: "1",
    PHASE_0J_WAVE2_INTEGRATION: "1",
    PHASE_0J_WAVE3_INTEGRATION: "1",
    PHASE_0J_WAVE4_INTEGRATION: "1",
    PHASE_0J1_INTEGRATION: "1",
    PHASE_0K_WAVE_A_INTEGRATION: "1",
  },
});

for (const gate of [
  {
    label: "Contracts tests (quota schemas + generated artifacts)",
    command: "pnpm",
    args: ["--filter", "@expense-tax/contracts", "test"],
  },
  {
    label: "Foundry service tests (quota/reservation routes/auth)",
    command: "pnpm",
    args: ["--filter", "@expense-tax/foundry-service", "test"],
  },
]) {
  runGate(gate);
}

let skippedDatabaseGate = false;
if (process.env.PHASE_0K_WAVE_B_INTEGRATION === "1") {
  runGate({
    label: "PostgreSQL service startup",
    command: composeScript,
    args: ["up", "-d", "postgres"],
  });
  runGate({
    label: "Phase 0K Wave B Foundry migrations (through 003)",
    command: composeScript,
    args: ["run", "--rm", "--build", "foundry-service-migrate"],
  });
  runGate({
    label: "Phase 0K Wave B PostgreSQL integration",
    command: "pnpm",
    args: [
      "exec",
      "vitest",
      "run",
      "test/integration/foundry-domain-quotas.test.ts",
    ],
    env: { ...process.env, PHASE_0K_WAVE_B_INTEGRATION: "1" },
  });
} else {
  skippedDatabaseGate = true;
  console.error(
    "\nSKIP Phase 0K Wave B PostgreSQL integration: PHASE_0K_WAVE_B_INTEGRATION must be 1",
  );
}

for (const gate of [
  {
    label: "Generated contract drift",
    command: "pnpm",
    args: ["contracts:check"],
  },
  {
    label: "Foundry service Docker build",
    command: composeScript,
    args: ["build", "foundry-service"],
  },
  {
    label: "Foundry service local readiness",
    command: composeScript,
    args: ["up", "-d", "foundry-service"],
  },
]) {
  runGate(gate);
}

waitForReady("Foundry service readiness probe", "http://127.0.0.1:8200/health/ready");

if (skippedDatabaseGate) {
  console.error("FAIL Phase 0K Wave B completion: required PostgreSQL checks were skipped");
  process.exit(1);
}

console.log("\nPASS Phase 0K Wave B aggregate verification: zero required checks skipped");
