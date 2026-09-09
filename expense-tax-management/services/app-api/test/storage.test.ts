import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStorageAdapter } from "../src/storage/factory.js";
import { createLocalStorageAdapter } from "../src/storage/local.js";
import {
  createContentSignature,
  toEpochSec,
  verifyContentSignature,
} from "../src/storage/signing.js";

const SIGNING_KEY = "test-signing-key-not-secret";
const FILE_ID = "11111111-1111-4111-8111-111111111111";

describe("content URL signing", () => {
  it("round-trips a valid signature", () => {
    const expiresEpochSec = toEpochSec(new Date(Date.now() + 60_000));
    const signature = createContentSignature({
      signingKey: SIGNING_KEY,
      method: "PUT",
      fileId: FILE_ID,
      expiresEpochSec,
    });
    expect(
      verifyContentSignature({
        signingKey: SIGNING_KEY,
        method: "PUT",
        fileId: FILE_ID,
        expiresEpochSec,
        signature,
        nowEpochSec: toEpochSec(new Date()),
      }),
    ).toBe("valid");
  });

  it("rejects forged, tampered, wrong-method, and expired signatures", () => {
    const expiresEpochSec = toEpochSec(new Date(Date.now() + 60_000));
    const signature = createContentSignature({
      signingKey: SIGNING_KEY,
      method: "PUT",
      fileId: FILE_ID,
      expiresEpochSec,
    });
    const base = {
      signingKey: SIGNING_KEY,
      fileId: FILE_ID,
      expiresEpochSec,
      signature,
      nowEpochSec: toEpochSec(new Date()),
    };
    expect(verifyContentSignature({ ...base, method: "GET" })).toBe("invalid");
    expect(
      verifyContentSignature({ ...base, method: "PUT", fileId: `${FILE_ID}0`.slice(1) }),
    ).toBe("invalid");
    expect(
      verifyContentSignature({ ...base, method: "PUT", signature: "0".repeat(64) }),
    ).toBe("invalid");
    expect(
      verifyContentSignature({ ...base, method: "PUT", signature: "not-hex" }),
    ).toBe("invalid");
    expect(
      verifyContentSignature({
        ...base,
        method: "PUT",
        nowEpochSec: expiresEpochSec + 1,
      }),
    ).toBe("expired");
  });
});

describe("local storage adapter", () => {
  let rootDir = "";

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = "";
    }
  });

  async function createAdapter() {
    rootDir = await mkdtemp(path.join(tmpdir(), "expense-tax-storage-test-"));
    return createLocalStorageAdapter({
      rootDir,
      baseUrl: "http://127.0.0.1:8100",
      signingKey: SIGNING_KEY,
    });
  }

  it("writes, stats, reads, and deletes objects", async () => {
    const adapter = await createAdapter();
    expect(await adapter.statObject("tenants/t1/originals/f1/a.jpg")).toBeNull();
    await adapter.writeObject({
      storageKey: "tenants/t1/originals/f1/a.jpg",
      data: Buffer.from("bytes"),
      contentType: "image/jpeg",
    });
    expect(await adapter.statObject("tenants/t1/originals/f1/a.jpg")).toEqual({
      exists: true,
      sizeBytes: 5,
    });
    expect(
      (await adapter.readObject("tenants/t1/originals/f1/a.jpg")).toString(),
    ).toBe("bytes");
    await adapter.deleteObject("tenants/t1/originals/f1/a.jpg");
    expect(await adapter.statObject("tenants/t1/originals/f1/a.jpg")).toBeNull();
    await adapter.deleteObject("tenants/t1/originals/f1/a.jpg");
  });

  it("rejects path-traversal storage keys", async () => {
    const adapter = await createAdapter();
    await expect(
      adapter.writeObject({
        storageKey: "../escape.jpg",
        data: Buffer.from("x"),
        contentType: "image/jpeg",
      }),
    ).rejects.toThrow("Invalid storage key");
    await expect(adapter.statObject("/absolute.jpg")).rejects.toThrow(
      "Invalid storage key",
    );
  });

  it("issues bearer-free content URLs carrying verifiable signatures", async () => {
    const adapter = await createAdapter();
    const expiresAt = new Date(Date.now() + 60_000);
    const target = await adapter.issueUploadTarget({
      fileId: FILE_ID,
      storageKey: "k",
      contentType: "image/jpeg",
      expiresAt,
    });
    expect(target.requiredHeaders).toEqual({ "Content-Type": "image/jpeg" });
    const uploadUrl = new URL(target.url);
    expect(uploadUrl.pathname).toBe(`/api/v1/file-content/${FILE_ID}`);
    const expiresEpochSec = Number(uploadUrl.searchParams.get("expires"));
    expect(
      verifyContentSignature({
        signingKey: SIGNING_KEY,
        method: "PUT",
        fileId: FILE_ID,
        expiresEpochSec,
        signature: uploadUrl.searchParams.get("signature") ?? "",
        nowEpochSec: toEpochSec(new Date()),
      }),
    ).toBe("valid");

    const read = await adapter.issueReadUrl({
      fileId: FILE_ID,
      storageKey: "k",
      expiresAt,
    });
    const readUrl = new URL(read.url);
    expect(
      verifyContentSignature({
        signingKey: SIGNING_KEY,
        method: "GET",
        fileId: FILE_ID,
        expiresEpochSec: Number(readUrl.searchParams.get("expires")),
        signature: readUrl.searchParams.get("signature") ?? "",
        nowEpochSec: toEpochSec(new Date()),
      }),
    ).toBe("valid");
  });
});

describe("storage factory", () => {
  it("builds the local adapter and refuses GCS until the infrastructure gate", () => {
    const local = createStorageAdapter({
      backend: "local",
      localDir: "/tmp/x",
      baseUrl: "http://127.0.0.1:8100",
      urlSigningKey: SIGNING_KEY,
    });
    expect(typeof local.issueUploadTarget).toBe("function");
    expect(() =>
      createStorageAdapter({
        backend: "gcs",
        localDir: "/tmp/x",
        baseUrl: "http://127.0.0.1:8100",
        urlSigningKey: SIGNING_KEY,
      }),
    ).toThrow("GCP infrastructure gate");
    expect(() =>
      createStorageAdapter({
        backend: "s3",
        localDir: "/tmp/x",
        baseUrl: "http://127.0.0.1:8100",
        urlSigningKey: SIGNING_KEY,
      }),
    ).toThrow("Unknown storage backend");
  });
});
