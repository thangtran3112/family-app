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

for (const gate of [
  {
    label: "Phase 0I regression verification",
    command: "pnpm",
    args: ["verify:phase-0i"],
    env: { ...process.env, PHASE_0I_INTEGRATION: "1" },
  },
  {
    label: "Phase 0J contract tests",
    command: "pnpm",
    args: [
      "--filter",
      "@expense-tax/contracts",
      "exec",
      "vitest",
      "run",
      "test/wave1-contracts.test.ts",
      "test/wave2-contracts.test.ts",
      "test/generated-artifacts.test.ts",
    ],
  },
  {
    label: "App API tests",
    command: "pnpm",
    args: ["--filter", "@expense-tax/app-api", "test"],
  },
]) {
  runGate(gate);
}

let skippedDatabaseGate = false;
if (process.env.PHASE_0J_WAVE2_INTEGRATION === "1") {
  runGate({
    label: "PostgreSQL service startup",
    command: composeScript,
    args: ["up", "-d", "postgres"],
  });
  runGate({
    label: "Phase 0J App API migrations",
    command: composeScript,
    args: ["run", "--rm", "--build", "app-api-migrate"],
  });
  runGate({
    label: "Wave 1 PostgreSQL integration",
    command: "pnpm",
    args: ["exec", "vitest", "run", "test/integration/app-domain-wave1.test.ts"],
    env: { ...process.env, PHASE_0J_INTEGRATION: "1" },
  });
  runGate({
    label: "Wave 2 PostgreSQL integration",
    command: "pnpm",
    args: ["exec", "vitest", "run", "test/integration/app-domain-wave2.test.ts"],
    env: { ...process.env, PHASE_0J_WAVE2_INTEGRATION: "1" },
  });
} else {
  skippedDatabaseGate = true;
  console.error(
    "\nSKIP Wave 2 PostgreSQL integration: PHASE_0J_WAVE2_INTEGRATION is not 1",
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
    label: "Credential boundary audit",
    command: "node",
    args: ["scripts/audit-credential-boundaries.mjs"],
  },
]) {
  runGate(gate);
}

if (skippedDatabaseGate) {
  console.error(
    "FAIL Phase 0J Wave 2 completion: required PostgreSQL checks were skipped",
  );
  process.exit(1);
}

console.log(
  "\nPASS Phase 0J Wave 2 aggregate verification: zero required checks skipped",
);
