import { z } from "zod";

// RFC 6901 pointers and a three-op subset of RFC 6902 (replace / add / remove). A strategy
// draft stores the user's edits as these ops, so `draftConfig + edits = finalConfig` can be
// replayed and checked in both languages. Mirror: ai_trading/contracts/json_pointer.py.

// Non-empty pointer: one or more "/token" segments, "~" only as "~0" or "~1".
export const JsonPointerSchema = z.string().max(200).regex(/^(\/([^/~]|~[01])*)+$/);

// JSON value without null or booleans (the whole contract family has neither).
export type JsonValue = string | number | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

export const EditSchema = z.union([
  z.strictObject({ op: z.enum(["replace", "add"]), path: JsonPointerSchema, value: JsonValueSchema }),
  z.strictObject({ op: z.literal("remove"), path: JsonPointerSchema }),
]);
export type Edit = z.infer<typeof EditSchema>;

export class EditError extends Error {}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

function tokens(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function child(container: unknown, token: string): { found: boolean; value?: unknown } {
  if (Array.isArray(container)) {
    if (!ARRAY_INDEX.test(token) || Number(token) >= container.length) return { found: false };
    return { found: true, value: container[Number(token)] };
  }
  if (isObject(container) && Object.hasOwn(container, token)) return { found: true, value: container[token] };
  return { found: false };
}

/** The value at `pointer`, or `{ found: false }`. */
export function resolvePointer(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current: unknown = doc;
  for (const token of tokens(pointer)) {
    const next = child(current, token);
    if (!next.found) return { found: false };
    current = next.value;
  }
  return { found: true, value: current };
}

/**
 * A copy of `doc` with `edits` applied in order. Throws EditError when an op cannot apply:
 * a missing target, an array index out of range, or a "__proto__" token.
 *   replace: the target must exist.
 *   add: the parent must exist; an object key is set; an array index inserts (index <= length);
 *        "-" appends.
 *   remove: the target must exist.
 */
export function applyEdits<T>(doc: T, edits: readonly Edit[]): T {
  let result = structuredClone(doc) as unknown;
  for (const edit of edits) {
    const parts = tokens(edit.path);
    if (parts.includes("__proto__")) throw new EditError(`${edit.path}: forbidden token`);
    const last = parts[parts.length - 1] as string;
    const parent = parts.length === 1 ? { found: true, value: result } : resolvePointer(result, `/${parts.slice(0, -1).map(escapeToken).join("/")}`);
    if (!parent.found) throw new EditError(`${edit.path}: parent not found`);
    const container = parent.value;
    if (Array.isArray(container)) {
      const index = last === "-" && edit.op === "add" ? container.length : ARRAY_INDEX.test(last) ? Number(last) : -1;
      if (index < 0) throw new EditError(`${edit.path}: bad array index`);
      if (edit.op === "add") {
        if (index > container.length) throw new EditError(`${edit.path}: index out of range`);
        container.splice(index, 0, structuredClone(edit.value));
      } else {
        if (index >= container.length) throw new EditError(`${edit.path}: index out of range`);
        if (edit.op === "replace") container[index] = structuredClone(edit.value);
        else container.splice(index, 1);
      }
    } else if (isObject(container)) {
      const exists = Object.hasOwn(container, last);
      if (edit.op !== "add" && !exists) throw new EditError(`${edit.path}: target not found`);
      if (edit.op === "remove") delete container[last];
      else container[last] = structuredClone(edit.value);
    } else {
      throw new EditError(`${edit.path}: parent is not a container`);
    }
  }
  return result as T;
}

function escapeToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Deep equality for JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return a === b;
}
