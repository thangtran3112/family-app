import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import { enqueue, listQueue, mergeQueueWithReviews, removeQueue, updateQueue } from "./queue";

describe("offline queue", () => {
  beforeEach(async () => {
    for (const item of await listQueue()) await removeQueue(item.id);
  });

  it("stores Blob bytes and progresses without losing identity", async () => {
    const file = new File(["receipt"], "receipt.jpg", { type: "image/jpeg" });
    const queued = await enqueue(file, "ocr_mode_balanced");
    expect((await listQueue())[0]?.filename).toBe("receipt.jpg");
    await updateQueue({ ...queued, status: "processing", progress: 78, fileId: "file-1" });
    expect((await listQueue())[0]).toMatchObject({
      id: queued.id,
      status: "processing",
      progress: 78,
      fileId: "file-1",
    });
  });

  it("removes canceled captures", async () => {
    const item = await enqueue(new File(["x"], "x.pdf", { type: "application/pdf" }), "ocr_mode_fast");
    await removeQueue(item.id);
    expect(await listQueue()).toEqual([]);
  });

  it.each(["queued", "uploading", "processing", "needs_input", "saved", "failed"] as const)(
    "persists the %s state",
    async (status) => {
      const item = await enqueue(new File(["x"], "state.jpg", { type: "image/jpeg" }), "ocr_mode_fast");
      await updateQueue({ ...item, status });
      expect((await listQueue())[0]?.status).toBe(status);
    },
  );

  it("merges local links with cross-device server reviews", async () => {
    const local = await enqueue(new File(["x"], "local.jpg", { type: "image/jpeg" }), "ocr_mode_balanced");
    await updateQueue({ ...local, status: "processing", fileId: "file-1", jobId: "job-1" });
    const baseReview = {
      schemaVersion: 1 as const,
      fileId: "file-1",
      jobId: "job-1",
      jobVersion: 2,
      fields: { merchant: null, total: null, currency: null, incurredOn: null, taxAmount: null },
      issues: ["merchant_missing" as const],
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:01:00.000Z",
    };

    const rows = mergeQueueWithReviews(await listQueue(), [
      baseReview,
      { ...baseReview, fileId: "file-2", jobId: "job-2" },
    ]);

    expect(rows.find((row) => row.jobId === "job-1")).toMatchObject({
      localId: local.id,
      filename: "local.jpg",
      status: "needs_input",
    });
    expect(rows.find((row) => row.jobId === "job-2")).toMatchObject({
      localId: null,
      fileId: "file-2",
      status: "needs_input",
    });
  });
});
