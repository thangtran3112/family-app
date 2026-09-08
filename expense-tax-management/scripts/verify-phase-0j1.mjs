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

runGate({
  label: "Phase 0I and Wave 1-4 regression verification",
  command: "pnpm",
  args: ["verify:phase-0j:wave4"],
  env: {
    ...process.env,
    PHASE_0I_INTEGRATION: "1",
    PHASE_0J_INTEGRATION: "1",
    PHASE_0J_WAVE2_INTEGRATION: "1",
    PHASE_0J_WAVE3_INTEGRATION: "1",
    PHASE_0J_WAVE4_INTEGRATION: "1",
  },
});

for (const gate of [
  {
    label: "Contracts tests (plans schemas + generated artifacts)",
    command: "pnpm",
    args: ["--filter", "@expense-tax/contracts", "test"],
  },
  {
    label: "App API tests (plans routes/auth)",
    command: "pnpm",
    args: ["--filter", "@expense-tax/app-api", "test"],
  },
]) {
  runGate(gate);
}

let skippedDatabaseGate = false;
if (process.env.PHASE_0J1_INTEGRATION === "1") {
  runGate({
    label: "PostgreSQL service startup",
    command: composeScript,
    args: ["up", "-d", "postgres"],
  });
  runGate({
    label: "Phase 0J1 App API migrations (through 007)",
    command: composeScript,
    args: ["run", "--rm", "--build", "app-api-migrate"],
  });
  runGate({
    label: "Phase 0J1 PostgreSQL integration",
    command: "pnpm",
    args: ["exec", "vitest", "run", "test/integration/app-domain-0j1.test.ts"],
    env: { ...process.env, PHASE_0J1_INTEGRATION: "1" },
  });
} else {
  skippedDatabaseGate = true;
  console.error(
    "\nSKIP Phase 0J1 PostgreSQL integration: PHASE_0J1_INTEGRATION must be 1",
  );
}

for (const gate of [
  {
    label: "Generated contract drift",
    command: "pnpm",
    args: ["contracts:check"],
  },
  {
    label: "App API Docker build",
    command: composeScript,
    args: ["build", "app-api"],
  },
  {
    label: "App API local readiness",
    command: composeScript,
    args: ["up", "-d", "app-api"],
  },
  {
    label: "Credential boundary audit",
    command: "node",
    args: ["scripts/audit-credential-boundaries.mjs"],
  },
]) {
  runGate(gate);
}

console.log("\n=== App API readiness probe ===");
let readinessPassed = false;
for (let attempt = 1; attempt <= 30; attempt += 1) {
  const result = spawnSync(
    "curl",
    ["--fail", "--silent", "--show-error", "http://127.0.0.1:8100/health/ready"],
    { cwd: repoRoot, env: process.env, encoding: "utf8" },
  );
  if (result.status === 0) {
    process.stdout.write(result.stdout);
    readinessPassed = true;
    break;
  }
  if (attempt < 30) spawnSync("sleep", ["1"], { cwd: repoRoot });
}
if (!readinessPassed) {
  console.error("FAIL App API readiness probe: timed out after 30 attempts");
  process.exit(1);
}
console.log("PASS App API readiness probe");

if (skippedDatabaseGate) {
  console.error("FAIL Phase 0J1 completion: required PostgreSQL checks were skipped");
  process.exit(1);
}

console.log("\nPASS Phase 0J1 aggregate verification: zero required checks skipped");
