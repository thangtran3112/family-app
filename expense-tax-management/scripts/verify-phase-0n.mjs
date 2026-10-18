import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTask7WithIsolatedAppApi } from "./task7-dispatch-isolation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = path.join(root, "scripts", "compose.sh");

class CommandFailure extends Error {
  constructor(label, status) {
    super(`${label} failed`);
    this.status = status;
  }
}

function run(label, command, args, env = process.env) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new CommandFailure(label, result.status ?? 1);
  }
  console.log(`PASS ${label}`);
}

function appApiContainerId() {
  const result = spawnSync(compose, ["ps", "-q", "app-api"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error || result.status !== 0) {
    throw new CommandFailure("Inspect App API lifecycle", result.status ?? 1);
  }
  return result.stdout.trim();
}

const appApiBeforeRegression = appApiContainerId();

try {
  if (appApiBeforeRegression) {
    throw new Error("Task 7 isolation refused: pre-existing App API must not be changed");
  }

  run("Regression through Office", "pnpm", ["verify:phase-0m"], {
    ...process.env,
    PHASE_0I_INTEGRATION: "1",
    PHASE_0J_INTEGRATION: "1",
    PHASE_0J_WAVE2_INTEGRATION: "1",
    PHASE_0J_WAVE3_INTEGRATION: "1",
    PHASE_0J_WAVE4_INTEGRATION: "1",
    PHASE_0J1_INTEGRATION: "1",
    PHASE_0K_WAVE_A_INTEGRATION: "1",
    PHASE_0K_WAVE_B_INTEGRATION: "1",
    PHASE_0L_INTEGRATION: "1",
    PHASE_0D_INTEGRATION: "1",
    PHASE_0C_INTEGRATION: "1",
    PHASE_0E_INTEGRATION: "1",
    PHASE_0P_INTEGRATION: "1",
  });

  for (const script of ["typecheck", "lint", "test", "build"]) {
    run(`Foundry Web ${script}`, "pnpm", ["--filter", "@expense-tax/foundry-web", script]);
  }
  run("Foundry service tests", "pnpm", ["--filter", "@expense-tax/foundry-service", "test"]);

  if (process.env.PHASE_0N_INTEGRATION !== "1") {
    throw new CommandFailure("PHASE_0N_INTEGRATION must be 1", 1);
  }

  run("Foundry operations integration", "pnpm", [
    "exec", "vitest", "run", "test/integration/foundry-domain-0n-operations.test.ts",
  ], { ...process.env, PHASE_0N_INTEGRATION: "1" });

  runTask7WithIsolatedAppApi({
    appApiWasRunning: Boolean(appApiBeforeRegression),
    appApiIsRunning: Boolean(appApiContainerId()),
    stopAppApi: () => run("Task 7 dispatcher isolation", compose, ["stop", "app-api"]),
    runTask7: () => run("Task 7 Stage A dispatch routing fence", "pnpm", [
      "exec", "vitest", "run", "test/integration/app-domain-task7-dispatch-routing.test.ts",
    ], { ...process.env, PHASE_T7A_INTEGRATION: "1" }),
    startAppApi: () => run("Restore chain-started App API", compose, ["up", "-d", "app-api"]),
  });

  run("Phase 3D-A Task 6 mailbox domain verification", "pnpm", [
    "exec", "vitest", "run", "test/integration/app-domain-3d-a-mailbox.test.ts",
  ], { ...process.env, PHASE_3D_A_T6_INTEGRATION: "1" });
  run("Phase 3D-B Task 2 mailbox lease/fence verification", "pnpm", [
    "--filter", "@expense-tax/app-api", "exec", "vitest", "run", "test/mailbox-scans.test.ts",
  ], { ...process.env, PHASE_3D_B_T2_INTEGRATION: "1" });
  run("Phase 3D-B Task 3 mailbox finalize/lease-release verification", "pnpm", [
    "--filter", "@expense-tax/app-api", "exec", "vitest", "run", "test/mailbox-finalize.test.ts",
  ], { ...process.env, PHASE_3D_B_T3_INTEGRATION: "1" });
  run("Phase 3D-B Task 6 mailbox discovery/review phase verification", "pnpm", [
    "exec", "vitest", "run", "test/integration/app-domain-3d-b-mailbox.test.ts",
  ], { ...process.env, PHASE_3D_B_T6_INTEGRATION: "1" });
  run("Phase 3D-C Task 7 mailbox ingestion phase verification", "pnpm", [
    "exec", "vitest", "run", "test/integration/app-domain-3d-c-mailbox.test.ts",
  ], { ...process.env, PHASE_3D_C_T7_INTEGRATION: "1" });
  run("Generated drift", "pnpm", ["contracts:check"]);
  run("Foundry Web Docker", compose, ["build", "foundry-web"]);
  run("Foundry Web readiness", compose, ["up", "-d", "foundry-web"]);

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (spawnSync("curl", ["--fail", "--silent", "http://127.0.0.1:7303/providers"]).status === 0) {
      ready = true;
      break;
    }
    spawnSync("sleep", ["1"]);
  }
  if (!ready) throw new CommandFailure("Foundry Web readiness probe", 1);
  console.log("PASS Phase 0N aggregate verification: zero required checks skipped");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof CommandFailure ? error.status : 1;
}
