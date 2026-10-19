import test from "node:test";
import { access } from "node:fs/promises";

test("static export contains the Desk entry point and Next assets", async () => {
  await access(new URL("./out/index.html", import.meta.url));
  await access(new URL("./out/_next/", import.meta.url));
});
