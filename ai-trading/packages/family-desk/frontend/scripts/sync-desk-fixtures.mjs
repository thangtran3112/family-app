// Copies the backend's trimmed API fixtures into lib/fixtures/<lane>/api. Run it after the
// backend fixtures change; never hand-edit the copies. Unit tests read them, screens never do.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 02m §a4 (technical) and 02n §h step 3b (Fundamental): one backend directory per lane.
for (const lane of ["desk-mvp", "desk-fundamental"]) {
  const source = fileURLToPath(new URL(`../../backend/tests/fixtures/${lane}/api/`, import.meta.url));
  const target = fileURLToPath(new URL(`../lib/fixtures/${lane}/api/`, import.meta.url));
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source).filter((file) => file.endsWith(".json"))) {
    cpSync(`${source}${name}`, `${target}${name}`);
  }
  console.log(`copied fixtures from ${source}`);
}
