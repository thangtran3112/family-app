// Copies the backend's trimmed API fixtures (02m §a4) into lib/fixtures/desk-mvp/api. Run it after the
// backend fixtures change; never hand-edit the copies. Unit tests read them, screens never do.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../backend/tests/fixtures/desk-mvp/api/", import.meta.url));
const target = fileURLToPath(new URL("../lib/fixtures/desk-mvp/api/", import.meta.url));
mkdirSync(target, { recursive: true });
for (const name of readdirSync(source).filter((file) => file.endsWith(".json"))) {
  cpSync(`${source}${name}`, `${target}${name}`);
}
console.log(`copied fixtures from ${source}`);
