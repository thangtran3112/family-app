import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const aiWorkerRoot = path.join(repoRoot, "services", "ai-worker");
const expenseContractsRoot = path.join(repoRoot, "common", "python", "expense-contracts");

function runGate({ label, command, args, env = process.env, cwd = repoRoot }) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
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

function waitForLogText(label, containerName, text, timeoutMs) {
  console.log(`\n=== ${label} ===`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync("docker", ["logs", containerName], { encoding: "utf8" });
    if (result.status === 0 && (result.stdout + result.stderr).includes(text)) {
      console.log(`PASS ${label}`);
      return;
    }
    spawnSync("sleep", ["1"]);
  }
  console.error(`FAIL ${label}: "${text}" did not appear in ${containerName} logs within ${timeoutMs}ms`);
  process.exit(1);
}

runGate({
  label: "Phase 0I/0J/0J1/0K (Waves A+B) regression verification",
  command: "pnpm",
  args: ["verify:phase-0k:wave-b"],
  env: {
    ...process.env,
    PHASE_0I_INTEGRATION: "1",
    PHASE_0J_INTEGRATION: "1",
    PHASE_0J_WAVE2_INTEGRATION: "1",
    PHASE_0J_WAVE3_INTEGRATION: "1",
    PHASE_0J_WAVE4_INTEGRATION: "1",
    PHASE_0J1_INTEGRATION: "1",
    PHASE_0K_WAVE_A_INTEGRATION: "1",
    PHASE_0K_WAVE_B_INTEGRATION: "1",
  },
});

for (const gate of [
  {
    label: "Contracts tests (job-reference/status/result schemas)",
    command: "pnpm",
    args: ["--filter", "@expense-tax/contracts", "test"],
  },
  {
    label: "App API tests (ProcessingJob routes/domain, Temporal client DI)",
    command: "pnpm",
    args: ["--filter", "@expense-tax/app-api", "test"],
  },
  {
    label: "expense-contracts Python tests",
    command: "uv",
    args: ["run", "pytest"],
    cwd: expenseContractsRoot,
  },
  {
    label: "ai-worker Python tests",
    command: "uv",
    args: ["run", "pytest"],
    cwd: aiWorkerRoot,
  },
  {
    label: "ai-worker ruff lint",
    command: "uv",
    args: ["run", "ruff", "check", "src", "tests"],
    cwd: aiWorkerRoot,
  },
]) {
  runGate(gate);
}

let skippedRequiredGates = false;

if (process.env.PHASE_0L_INTEGRATION === "1") {
  runGate({
    label: "PostgreSQL + Temporal service startup",
    command: composeScript,
    args: ["up", "-d", "postgres", "temporal"],
  });
  runGate({
    label: "Phase 0L App API migrations (through 008)",
    command: composeScript,
    args: ["run", "--rm", "--build", "app-api-migrate"],
  });
  runGate({
    label: "Phase 0L PostgreSQL + real-Temporal-dispatch integration",
    command: "pnpm",
    args: ["exec", "vitest", "run", "test/integration/app-domain-0l-jobs.test.ts"],
    env: { ...process.env, PHASE_0L_INTEGRATION: "1" },
  });
} else {
  skippedRequiredGates = true;
  console.error("\nSKIP Phase 0L PostgreSQL + real-Temporal-dispatch integration: PHASE_0L_INTEGRATION must be 1");
}

if (process.env.PHASE_0L_WORKER_LOOP === "1") {
  runGate({
    label: "Phase 0L real Python worker loop (Fastify + spawned worker process + real Temporal)",
    command: "pnpm",
    args: ["exec", "vitest", "run", "test/integration/app-domain-0l-worker-loop.test.ts"],
    env: { ...process.env, PHASE_0L_WORKER_LOOP: "1" },
  });
} else {
  skippedRequiredGates = true;
  console.error("\nSKIP Phase 0L real Python worker loop: PHASE_0L_WORKER_LOOP must be 1");
}

for (const gate of [
  {
    label: "Generated contract drift",
    command: "pnpm",
    args: ["contracts:check"],
  },
  {
    label: "ai-worker Docker build",
    command: composeScript,
    args: ["build", "ai-worker"],
  },
  {
    label: "ai-worker local readiness",
    command: composeScript,
    args: ["up", "-d", "ai-worker"],
  },
]) {
  runGate(gate);
}

waitForLogText(
  "ai-worker task-queue polling readiness",
  "expense-tax-ai-worker",
  "polling task queue",
  15_000,
);

if (skippedRequiredGates) {
  console.error("FAIL Phase 0L completion: required checks were skipped");
  process.exit(1);
}

console.log("\nPASS Phase 0L aggregate verification: zero required checks skipped");
