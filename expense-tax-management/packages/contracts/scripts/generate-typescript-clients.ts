import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

function generatedRoot(): string {
  return process.env.CONTRACTS_GENERATED_ROOT
    ? path.resolve(process.env.CONTRACTS_GENERATED_ROOT)
    : fileURLToPath(new URL("../generated", import.meta.url));
}

async function generateTypes(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const document = JSON.parse(await readFile(inputPath, "utf8"));
  const ast = await openapiTS(document, { alphabetize: true });
  const output = `${astToString(ast).trimEnd()}\n`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, "utf8");
}

export async function generateTypescriptClients(
  outputRoot = generatedRoot(),
): Promise<void> {
  await generateTypes(
    path.join(outputRoot, "openapi", "app-api.openapi.json"),
    path.join(outputRoot, "typescript", "app-api.paths.ts"),
  );
  await generateTypes(
    path.join(outputRoot, "openapi", "foundry-service.openapi.json"),
    path.join(outputRoot, "typescript", "foundry-service.paths.ts"),
  );
}

async function main(): Promise<void> {
  await generateTypescriptClients();
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error("TypeScript client type generation failed", error);
    process.exitCode = 1;
  });
}
