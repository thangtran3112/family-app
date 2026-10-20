import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Execute the workflow's real shell commands with offline process boundaries.
// actionlint validates YAML; these tests catch install order and upload wiring.
const workflow = readFileSync(new URL("../../../.github/workflows/ai-trading-deploy.yml", import.meta.url), "utf8");
const job = workflow.split("  desk-static-upload:\n")[1].split("  mirofish-static-upload:\n")[0];
const runs = [...job.matchAll(/^      - (?:name: ([^\n]+)\n(?:        [^\n]*\n)*?        run:|run:) (.*)\n((?:          [^\n]*\n)*)/gm)]
  .map((match) => ({ name: match[1], command: match[2] === "|" ? match[3].replace(/^          /gm, "") : match[2] }));

function sandbox(run) {
  const root = mkdtempSync(join(tmpdir(), "desk-upload-wiring-"));
  try {
    const frontend = join(root, "ai-trading/packages/family-desk/frontend");
    mkdirSync(frontend, { recursive: true });
    mkdirSync(join(frontend, "../contracts"));
    mkdirSync(join(root, "bin"));
    run(root, frontend);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("release installs linked contracts frozen before frontend install and build", () => {
  sandbox((root, cwd) => {
    writeFileSync(join(root, "bin/pnpm"), `#!/bin/sh
set -eu
if [ "$1" = --dir ]; then cd "$2"; shift 2; fi
case "$1" in
  install)
    [ "$2" = --frozen-lockfile ]
    if [ "$(basename "$PWD")" = frontend ]; then test -f ../contracts/installed; fi
    touch installed ;;
  build) test -f installed; test -f ../contracts/installed ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    const commands = runs.filter(({ command }) => /\bpnpm\b/.test(command));
    assert.ok(commands.some(({ command }) => command.includes("build")));
    const result = spawnSync("bash", ["-euc", commands.map(({ command }) => command).join("\n")], {
      cwd, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || "frontend install ran before linked contracts install");
  });
});

test("release upload derives bucket from configured project without a repository bucket variable", () => {
  sandbox((root, cwd) => {
    const scripts = join(root, "ai-trading/deploy/ci");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "upload-hub-static.sh"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$UPLOAD_ARGS"\n', { mode: 0o755 });
    const upload = runs.find(({ name }) => name === "Upload Desk static build to GCS");
    assert.ok(upload, "upload step shell must be exercised");
    for (const project of ["tobytran-portfolio", "offline-project"]) {
      const args = join(root, "args");
      const result = spawnSync("bash", ["-euc", upload.command], {
        cwd, env: { ...process.env, GCP_PROJECT_ID: project, DESK_STATIC_BUCKET: "", UPLOAD_ARGS: args }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(args, "utf8"), `out\n${project}-ai-trading-desk\ndesk\n`);
    }
  });
});
