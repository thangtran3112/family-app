import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { FilterStrategySpecV1Schema } from "../src/filter-strategy-spec-v1.ts";
import { PracticeBlockV1Schema } from "../src/practice-block-v1.ts";
import {
  PracticeLedgerEntryV1Schema,
  PracticeThreadCreateV1Schema,
  PracticeThreadPatchV1Schema,
  PracticeThreadV1Schema,
} from "../src/practice-thread-v1.ts";
import { PresetCatalogV1Schema } from "../src/preset-catalog-v1.ts";
import { PracticeMarkV1Schema, ReplaySessionV1Schema } from "../src/replay-session-v1.ts";
import { StrategySpecV1Schema } from "../src/strategy-spec-v1.ts";

export const FILE_NAME = "strategy-spec-v1.schema.json";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

type JsonSchema = { $defs: Record<string, unknown> } & Record<string, unknown>;

function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as JsonSchema;
}

// One bundle, so datamodel-codegen emits one module and the shared operand classes exist once.
// The root is StrategySpecV1; FilterStrategySpecV1 and PresetCatalogV1 ride along as extra
// `$defs`, and so do ReplaySessionV1 and PracticeMarkV1 (02o) and PracticeBlockV1 (02o-b), and the practice-thread family (02r). A def shared by several schemas (Condition, SeriesOperand, ...) must be identical.
export function renderJsonSchema(): string {
  const bundle = toJsonSchema(StrategySpecV1Schema);
  for (const schema of [
    FilterStrategySpecV1Schema,
    PresetCatalogV1Schema,
    ReplaySessionV1Schema,
    PracticeMarkV1Schema,
    PracticeBlockV1Schema,
    PracticeThreadCreateV1Schema,
    PracticeThreadPatchV1Schema,
    PracticeThreadV1Schema,
    PracticeLedgerEntryV1Schema,
  ]) {
    for (const [name, def] of Object.entries(toJsonSchema(schema).$defs)) {
      const known = bundle.$defs[name];
      if (known !== undefined && JSON.stringify(sortJson(known)) !== JSON.stringify(sortJson(def))) {
        throw new Error(`$defs.${name} differs between schemas`);
      }
      bundle.$defs[name] = def;
    }
  }
  return `${JSON.stringify(sortJson(bundle), null, 2)}\n`;
}

export async function writeJsonSchema(outputDir: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, FILE_NAME);
  await writeFile(outputPath, renderJsonSchema(), "utf8");
  return outputPath;
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  await writeJsonSchema(fileURLToPath(new URL("../generated", import.meta.url)));
}
