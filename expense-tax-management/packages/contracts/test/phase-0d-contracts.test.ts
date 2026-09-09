import { describe, expect, it } from "vitest";

import {
  CreateUploadSessionRequestSchema,
  ExpenseFileSchema,
  FileContentTypeSchema,
  MAX_UPLOAD_BYTES,
} from "../src/index.js";

const FILE_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

function validFile(overrides: Record<string, unknown> = {}) {
  return ExpenseFileSchema.parse({
    id: FILE_ID,
    tenantId: TENANT_ID,
    personalProfileId: PROFILE_ID,
    businessId: null,
    expenseId: null,
    originalFilename: "receipt.jpg",
    contentType: "image/jpeg",
    sizeBytes: null,
    sha256Hex: null,
    storageKey: `tenants/${TENANT_ID}/personal-${PROFILE_ID}/originals/${FILE_ID}/receipt.jpg`,
    thumbnailStorageKey: null,
    thumbnailStatus: "pending",
    status: "PENDING",
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  });
}

describe("Phase 0D file contracts", () => {
  it("caps uploads at 25MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });

  it("restricts content types to images and PDF", () => {
    expect(FileContentTypeSchema.options).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ]);
    expect(() =>
      CreateUploadSessionRequestSchema.parse({
        originalFilename: "receipt.exe",
        contentType: "application/x-msdownload",
      }),
    ).toThrow();
  });

  it("rejects an expected size over the cap", () => {
    expect(() =>
      CreateUploadSessionRequestSchema.parse({
        originalFilename: "big.pdf",
        contentType: "application/pdf",
        expectedSizeBytes: MAX_UPLOAD_BYTES + 1,
      }),
    ).toThrow();
  });

  it("requires exactly one Personal or business scope on a file (nullable pair, validated in domain)", () => {
    const file = validFile();
    expect(file.personalProfileId).toBe(PROFILE_ID);
    expect(file.businessId).toBeNull();
    // Both null / both set are contract-valid shapes here (the DB CHECK +
    // domain guard enforce exactly-one); the contract only guarantees the
    // pair is present and nullable, never absent.
    expect(validFile({ personalProfileId: null, businessId: null }).businessId).toBeNull();
  });

  it("requires a 64-hex sha256 once present", () => {
    expect(() => validFile({ sha256Hex: "not-a-hash" })).toThrow();
    expect(
      validFile({
        sha256Hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      }).sha256Hex,
    ).toHaveLength(64);
  });
});
