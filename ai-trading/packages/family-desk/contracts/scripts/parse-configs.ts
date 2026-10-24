// Parses every `*.json` file in the given directories with StrategyConfigSchema. Exits 1 when a
// file fails (or, with --expect-fail, when a file passes). The backend's cross-check test runs it
// over Pydantic's own serialization of the shared fixtures, so Pydantic JSON must be Zod JSON.
//   node scripts/parse-configs.ts [--expect-fail] <directory>...
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { StrategyConfigSchema } from "../src/strategy-config.ts";

const args = process.argv.slice(2);
const expectFail = args.includes("--expect-fail");
let wrong = 0;
let seen = 0;
for (const directory of args.filter((arg) => arg !== "--expect-fail")) {
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".json")).sort()) {
    const result = StrategyConfigSchema.safeParse(JSON.parse(readFileSync(path.join(directory, name), "utf8")));
    seen += 1;
    if (result.success === expectFail) {
      wrong += 1;
      console.error(`${name}: ${result.success ? "unexpectedly accepted" : JSON.stringify(result.error.issues)}`);
    }
  }
}
console.log(`checked ${seen} configs, ${wrong} wrong`);
process.exit(wrong === 0 && seen > 0 ? 0 : 1);
