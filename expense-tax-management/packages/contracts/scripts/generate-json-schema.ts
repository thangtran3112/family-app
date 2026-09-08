import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JobReferenceV1Schema } from "../src/index.js";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function generatedRoot(): string {
  return process.env.CONTRACTS_GENERATED_ROOT
    ? path.resolve(process.env.CONTRACTS_GENERATED_ROOT)
    : fileURLToPath(new URL("../generated", import.meta.url));
}

export async function generateJsonSchema(outputRoot = generatedRoot()): Promise<void> {
  const schema = {
    ...JobReferenceV1Schema.toJSONSchema({
      target: "draft-2020-12",
      io: "input",
    }),
    title: "JobReferenceV1",
  };
  const outputPath = path.join(
    outputRoot,
    "json-schema",
    "internal-messages.schema.json",
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(sortJson(schema), null, 2)}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  await generateJsonSchema();
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error("JSON Schema generation failed", error);
    process.exitCode = 1;
  });
}
