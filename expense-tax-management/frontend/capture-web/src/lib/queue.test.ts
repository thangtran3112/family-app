import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import { enqueue, listQueue, removeQueue, updateQueue } from "./queue";

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
});
