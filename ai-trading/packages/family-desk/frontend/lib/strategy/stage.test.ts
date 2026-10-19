import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { nextStage, stageOptions } from "./stage.ts";

test("Phase 4 exposes draft and alert-only, defers paper, and never offers live", () => {
  assert.deepEqual(stageOptions(4), [
    { stage: "draft", label: "Draft", enabled: true },
    { stage: "alert_only", label: "Alert only", enabled: true },
    { stage: "paper", label: "Paper", enabled: false, reason: "Phase 6" },
    { label: "Live", enabled: false, reason: "Not in v1" },
  ]);
  assert.equal(JSON.stringify(stageOptions(4)).includes("live_confirm"), false);
  assert.equal(JSON.stringify(stageOptions(4)).includes("live_auto"), false);
});

test("stage progression allows only the next backend transition", () => {
  assert.equal(nextStage("draft"), "alert_only");
  assert.equal(nextStage("alert_only"), "paper");
  assert.equal(nextStage("paper"), null);
});

test("Desk API and app source contain no order endpoint or client", async () => {
  const frontend = new URL("../../", import.meta.url).pathname;
  async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name) ? [path] : [];
    }));
    return nested.flat();
  }

  const files = [
    ...await sourceFiles(join(frontend, "lib/api")),
    ...await sourceFiles(join(frontend, "app")),
  ];
  for (const file of files) {
    assert.equal((await readFile(file, "utf8")).includes("/orders"), false, file);
  }
});
