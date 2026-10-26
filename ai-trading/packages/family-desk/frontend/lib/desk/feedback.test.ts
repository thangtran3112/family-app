import assert from "node:assert/strict";
import test from "node:test";
import { createDeskApiClient, DeskApiError } from "../api/client.ts";
import { FeedbackDetailSchema, FeedbackListSchema, FeedbackUploadSchema } from "../feedback/schemas.ts";
import { createFeedbackReport, feedbackListPath, loadFeedback, loadFeedbackReport, screenshotUrl } from "./feedback.ts";

type Call = { method: string; path: string; body: unknown };

/** A client over a fake fetch: answers with `answer` and records each request. */
function fakeDesk(answer: unknown, status = 200) {
  const calls: Call[] = [];
  const client = createDeskApiClient(
    async (input, init) => {
      const url = input as URL;
      calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return Response.json(answer, { status });
    },
    () => ({ href: "https://trading.test/" }),
  );
  return { client, calls };
}

const item = {
  id: 14,
  ref: "F-014",
  kind: "bug",
  severity: "P2",
  title: "Day list marks Day 4 done before the replay ends",
  route: "/practice/day?id=5",
  area: "practice",
  reported_by: "W",
  updated_at: "2026-10-29T20:40:00Z",
  status: "fixed",
  fix_ref: "1a2b3c4",
};
const list = { items: [item], counts: { open: 0, in_progress: 0, fixed: 1, wont_fix: 0, duplicate: 0 } };
const detail = {
  ...item,
  body: "On Practice · Day list, the Day 4 row turns green too early.",
  expected: "It should stay In progress.",
  screen: "Practice · Day list",
  app_version: "desk-2026.10.25",
  context: { day_list_id: 5 },
  captured_at: "2026-10-25T13:14:00Z",
  links: [{ label: "Chart screenshot", url: "https://trading.tobytran.dev/practice/day?id=5" }],
  attachments: [{ id: 3, filename: "day-list.png", size_bytes: 421888, content_type: "image/png" }],
  events: [
    { at: "2026-10-25T13:14:00Z", actor: "user", from_status: null, to_status: "open", note: null },
    { at: "2026-10-29T20:40:00.123456Z", actor: "claude-code", from_status: "open", to_status: "fixed", note: "1a2b3c4" },
  ],
  duplicate_of: null,
};

test("the list path sends only the filters that are set, with the statuses repeated", () => {
  assert.equal(feedbackListPath(), "/api/desk/feedback");
  assert.equal(feedbackListPath({ sort: "newest" }), "/api/desk/feedback?sort=newest");
  assert.equal(
    feedbackListPath({ status: ["open", "in_progress"], kind: "bug", area: "practice", q: "day list", sort: "updated", limit: 50 }),
    "/api/desk/feedback?kind=bug&area=practice&q=day+list&sort=updated&limit=50&status=open&status=in_progress",
  );
  assert.equal(feedbackListPath({ status: ["fixed"] }), "/api/desk/feedback?status=fixed");
});

test("the loaders GET the documented paths and parse the answers", async () => {
  let d = fakeDesk(list);
  const answer = await loadFeedback({ status: ["fixed"], sort: "newest" }, { client: d.client });
  assert.equal(answer.items[0]!.ref, "F-014");
  assert.equal(answer.counts.fixed, 1);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/feedback?sort=newest&status=fixed", body: undefined });

  d = fakeDesk(detail);
  const report = await loadFeedbackReport(14, { client: d.client });
  assert.equal(report.events.length, 2);
  assert.equal(report.attachments[0]!.id, 3);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/feedback/14", body: undefined });
});

test("filing a report POSTs the body and answers with the new report", async () => {
  const d = fakeDesk(detail, 201);
  const body = {
    kind: "bug" as const,
    severity: "P2" as const,
    title: "Day list marks Day 4 done",
    body: "It turns green too early.",
    screen: "Practice · Day list",
    route: "/practice/day?id=5",
    app_version: "desk-2026.10.26",
    context: { day_list_id: 5 },
    captured_at: "2026-10-26T14:12:00.000Z",
    links: [],
    attachment_ids: [3],
  };
  const created = await createFeedbackReport(body, { client: d.client });
  assert.equal(created.ref, "F-014");
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/feedback", body });
});

test("a field problem from the API arrives as plain sentences", async () => {
  const d = fakeDesk({ detail: { problems: [{ path: "severity", message: "A bug needs a severity" }] } }, 422);
  await assert.rejects(
    createFeedbackReport({ kind: "bug", title: "x", body: "y", screen: "Today", route: "/", app_version: "desk-dev", context: {}, captured_at: "2026-10-26T14:12:00.000Z", links: [], attachment_ids: [] }, { client: d.client }),
    (error: unknown) => error instanceof DeskApiError && error.status === 422 && error.problems[0]!.message === "A bug needs a severity",
  );
  const missing = fakeDesk({ detail: "Report not found" }, 404);
  await assert.rejects(loadFeedbackReport(99, { client: missing.client }), (error: unknown) => error instanceof DeskApiError && error.status === 404);
});

test("the schemas accept the API's shapes, an empty log, and a staged upload, and refuse a changed status word", () => {
  assert.equal(FeedbackListSchema.parse(list).items.length, 1);
  assert.deepEqual(FeedbackListSchema.parse({ items: [], counts: { open: 0, in_progress: 0, fixed: 0, wont_fix: 0, duplicate: 0 } }).items, []);
  assert.equal(FeedbackDetailSchema.parse(detail).context.day_list_id, 5);
  assert.deepEqual(FeedbackUploadSchema.parse({ id: 4, filename: "a.png", size_bytes: 10, content_type: "image/png", report_id: null }).report_id, null);
  assert.throws(() => FeedbackListSchema.parse({ ...list, items: [{ ...item, status: "closed" }] }));
  assert.throws(() => FeedbackDetailSchema.parse({ ...detail, events: [{ ...detail.events[0], actor: "stranger" }] }));
});

test("a screenshot is read from the Desk's own API, never a third-party host", () => {
  assert.equal(screenshotUrl(3), "/api/desk/feedback/attachments/3");
});
