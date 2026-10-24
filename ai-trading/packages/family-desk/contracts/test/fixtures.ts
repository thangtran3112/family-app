import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every `*.json` file in `directory` (relative to the contracts root), sorted by name. */
export function jsonFiles(directory: string): [string, unknown][] {
  const full = path.join(root, directory);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(path.join(full, name), "utf8"))]);
}
