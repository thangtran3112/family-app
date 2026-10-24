// Parses every `*.json` file in the given directories with one Zod schema. Exits 1 when a file
// fails (or, with --expect-fail, when a file passes). The backend's cross-check test runs it over
// Pydantic's own serialization of the shared fixtures, so Pydantic JSON must be Zod JSON.
//   node scripts/parse-configs.ts --schema spec|filter|alert|draft|catalog [--expect-fail] <directory>...
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AlertStrategySpecV1Schema } from "../src/alert-strategy.ts";
import { FilterStrategySpecV1Schema } from "../src/filter-strategy-spec-v1.ts";
import { PresetCatalogV1Schema } from "../src/preset-catalog-v1.ts";
import { StrategyDraftSchema } from "../src/strategy-draft.ts";
import { StrategySpecV1Schema } from "../src/strategy-spec-v1.ts";

const SCHEMAS = {
  spec: StrategySpecV1Schema,
  filter: FilterStrategySpecV1Schema,
  alert: AlertStrategySpecV1Schema,
  draft: StrategyDraftSchema,
  catalog: PresetCatalogV1Schema,
};

const args = process.argv.slice(2);
const expectFail = args.includes("--expect-fail");
const schemaFlag = args.indexOf("--schema");
const schema = SCHEMAS[args[schemaFlag + 1] as keyof typeof SCHEMAS];
if (schemaFlag < 0 || !schema) {
  console.error("usage: parse-configs.ts --schema spec|filter|alert|draft|catalog [--expect-fail] <directory>...");
  process.exit(2);
}
const directories = args.filter((arg, index) => !arg.startsWith("--") && index !== schemaFlag + 1);

let wrong = 0;
let seen = 0;
for (const directory of directories) {
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".json")).sort()) {
    const result = schema.safeParse(JSON.parse(readFileSync(path.join(directory, name), "utf8")));
    seen += 1;
    if (result.success === expectFail) {
      wrong += 1;
      console.error(`${name}: ${result.success ? "unexpectedly accepted" : JSON.stringify(result.error.issues)}`);
    }
  }
}
console.log(`checked ${seen} configs, ${wrong} wrong`);
process.exit(wrong === 0 && seen > 0 ? 0 : 1);
