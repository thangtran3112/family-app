import { spawnSync } from "node:child_process";

// `compose up -d` returns once the container starts, not once the app listens.
// One probe right after it races the bind, so poll within a bounded budget.
export function waitForReady(
  probe,
  { attempts = 30, pause = () => spawnSync("sleep", ["1"]) } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (probe()) return true;
    if (attempt < attempts) pause();
  }
  return false;
}
