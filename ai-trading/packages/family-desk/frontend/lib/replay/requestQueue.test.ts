import assert from "node:assert/strict";
import test from "node:test";
import { createRequestQueue } from "./requestQueue.ts";

test("tasks run in the order they were queued, each after the one before has answered", async () => {
  const queue = createRequestQueue();
  const order: string[] = [];
  const slow = queue.run(async () => {
    await new Promise((done) => setTimeout(done, 5));
    order.push("slow");
    return 1;
  });
  const quick = queue.run(async () => {
    order.push("quick");
    return 2;
  });
  assert.equal(await slow, 1);
  assert.equal(await quick, 2);
  assert.deepEqual(order, ["slow", "quick"]);
});

test("a failing task answers null and does not stop the queue", async () => {
  const queue = createRequestQueue();
  const failed = queue.run(async () => {
    throw new Error("surprise");
  });
  const after = queue.run(async () => 7);
  assert.equal(await failed, null);
  assert.equal(await after, 7);
});
