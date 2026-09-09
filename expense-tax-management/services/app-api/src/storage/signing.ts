import { createHmac, timingSafeEqual } from "node:crypto";

import type { SignedContentMethod } from "./types.js";

export interface ContentSignatureInput {
  readonly signingKey: string;
  readonly method: SignedContentMethod;
  readonly fileId: string;
  readonly expiresEpochSec: number;
}

function signaturePayload(
  method: SignedContentMethod,
  fileId: string,
  expiresEpochSec: number,
): string {
  return `${method}\n${fileId}\n${expiresEpochSec}`;
}

export function createContentSignature(input: ContentSignatureInput): string {
  return createHmac("sha256", input.signingKey)
    .update(signaturePayload(input.method, input.fileId, input.expiresEpochSec))
    .digest("hex");
}

export interface VerifyContentSignatureInput extends ContentSignatureInput {
  readonly signature: string;
  readonly nowEpochSec: number;
}

/**
 * Verifies a bearer-free content URL signature. Returns false (never
 * throws) for malformed signatures, method/file mismatches, and expired
 * URLs, so routes can uniformly map any failure to 403/410 without
 * leaking which check failed first... actually expiry maps to 410 GONE
 * while bad signature maps to 403, so callers need the distinction:
 * this returns "valid" | "expired" | "invalid".
 */
export function verifyContentSignature(
  input: VerifyContentSignatureInput,
): "valid" | "expired" | "invalid" {
  if (!/^[a-f0-9]{64}$/.test(input.signature)) return "invalid";
  const expected = createContentSignature(input);
  const actual = Buffer.from(input.signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    actual.length !== expectedBuffer.length ||
    !timingSafeEqual(actual, expectedBuffer)
  ) {
    return "invalid";
  }
  if (input.nowEpochSec > input.expiresEpochSec) return "expired";
  return "valid";
}

export function toEpochSec(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
