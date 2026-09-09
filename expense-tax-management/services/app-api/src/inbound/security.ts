import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { InboundWebhookRequest } from "@expense-tax/contracts";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacHex(key: string, value: string | Buffer): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

export function verifyWebhookSignature(
  key: string,
  rawBody: Buffer,
  signature: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(hmacHex(key, rawBody), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function emailAuthAccepted(auth: InboundWebhookRequest["auth"]): boolean {
  return auth.arc === "pass" || (auth.dmarc === "pass" && (auth.spf === "pass" || auth.dkim === "pass"));
}

export function attachmentMagicMatches(contentType: string, bytes: Buffer): boolean {
  if (contentType === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

const EICAR_MARKER = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export interface MalwareScanner {
  scan(bytes: Buffer): Promise<{ readonly clean: boolean; readonly finding?: string }>;
}

/** Local deterministic scanner. EICAR proves the quarantine seam; a full AV
 * engine adapter remains pre-release infrastructure work. */
export const PatternMalwareScanner: MalwareScanner = {
  async scan(bytes) {
    return bytes.includes(Buffer.from(EICAR_MARKER, "ascii"))
      ? { clean: false, finding: "EICAR_TEST_SIGNATURE" }
      : { clean: true };
  },
};
