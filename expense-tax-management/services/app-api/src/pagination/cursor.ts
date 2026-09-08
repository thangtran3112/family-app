import { createHash } from "node:crypto";

import { z } from "zod";

const CursorScopeSchema = z.strictObject({
  tenantId: z.uuid(),
  profileId: z.uuid().optional(),
  businessId: z.uuid().optional(),
});

const CursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  scope: CursorScopeSchema,
  filterHash: z.string().regex(/^[a-f0-9]{64}$/),
  sort: z.enum(["incurredOn", "amount", "merchant", "createdAt"]),
  direction: z.enum(["asc", "desc"]),
  lastValue: z.string().min(1),
  lastId: z.uuid(),
});

export type LedgerCursorScope = z.infer<typeof CursorScopeSchema>;
export type LedgerCursorPayload = z.infer<typeof CursorPayloadSchema>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined && entry !== null)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function ledgerFilterHash(query: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue({ ...query, cursor: undefined })))
    .digest("hex");
}

export function encodeLedgerCursor(
  payload: Omit<LedgerCursorPayload, "version">,
): string {
  return Buffer.from(
    JSON.stringify({ version: 1, ...payload }),
    "utf8",
  ).toString("base64url");
}

export function decodeLedgerCursor(value: string): LedgerCursorPayload {
  try {
    return CursorPayloadSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new Error("Invalid ledger cursor");
  }
}
