import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import type { FeedbackDetail, FeedbackEvent } from "../feedback/schemas.ts";
import {
  agentLine,
  areaLabel,
  areaOptions,
  checkScreenshot,
  countsText,
  createdAt,
  defaultFilters,
  describeFix,
  emptyFields,
  filledLinks,
  formatBytes,
  formatEtDayTime,
  formatEtDayTimeShort,
  formatShortDay,
  linkHost,
  listFootnote,
  READY_TEXT,
  refOf,
  reporterInitial,
  removeFailureText,
  safeHref,
  sendError,
  sendReason,
  severityText,
  STATUSES,
  timeline,
  toCreateBody,
  toggleStatus,
  toQuery,
  totalOf,
  uploadFailureText,
  type FormDraft,
  type UploadItem,
} from "./feedbackView.ts";

const opened: FeedbackEvent = { at: "2026-10-25T13:14:00Z", actor: "user", from_status: null, to_status: "open", note: null };
const started: FeedbackEvent = { at: "2026-10-26T12:02:00Z", actor: "claude-code", from_status: "open", to_status: "in_progress", note: null };
const fixed: FeedbackEvent = { at: "2026-10-29T20:40:00Z", actor: "claude-code", from_status: "in_progress", to_status: "fixed", note: "1a2b3c4" };

const detail = (status: FeedbackDetail["status"], events: FeedbackEvent[], extra: Partial<FeedbackDetail> = {}) => ({
  status,
  fix_ref: null,
  updated_at: "2026-10-26T12:02:00Z",
  duplicate_of: null,
  events,
  ...extra,
});

test("ids print as F-nnn, padded to three digits and never cut", () => {
  assert.equal(refOf(7), "F-007");
  assert.equal(refOf(14), "F-014");
  assert.equal(refOf(1234), "F-1234");
});

test("the status chips toggle one at a time and never leave the list empty", () => {
  assert.deepEqual(toggleStatus(STATUSES, "fixed"), ["open", "in_progress", "wont_fix", "duplicate"]);
  assert.deepEqual(toggleStatus(["open", "wont_fix"], "fixed"), ["open", "fixed", "wont_fix"]); // keeps the chip order
  assert.deepEqual(toggleStatus(["open"], "open"), [...STATUSES]); // the last chip off turns them all on
});

test("the request leaves out every filter that is at its default, and sends the statuses only when some are off", () => {
  assert.deepEqual(toQuery(defaultFilters()), { status: undefined, kind: undefined, area: undefined, q: undefined, sort: "newest" });
  assert.deepEqual(
    toQuery({ kind: "bug", statuses: ["open", "in_progress"], area: "practice", q: "  day list ", sort: "updated" }),
    { status: ["open", "in_progress"], kind: "bug", area: "practice", q: "day list", sort: "updated" },
  );
});

test("counts read as the board's header line and the footnote says how many of the log are shown", () => {
  const counts = { open: 3, in_progress: 2, fixed: 1, wont_fix: 1, duplicate: 1 };
  assert.equal(countsText(counts), "Open 3 · In progress 2 · Fixed 1 · Won't fix 1 · Duplicate 1");
  assert.equal(totalOf(counts), 8);
  assert.equal(listFootnote(8, 8), "8 reports");
  assert.equal(listFootnote(3, 8), "3 of 8 reports");
  assert.equal(listFootnote(1, 1), "1 report");
});

test("the area select offers the areas in the list plus the one chosen, and prints them capitalised", () => {
  assert.deepEqual(areaOptions([{ area: "practice" }, { area: "chart" }, { area: "practice" }], ""), ["chart", "practice"]);
  assert.deepEqual(areaOptions([{ area: "practice" }], "alerts"), ["alerts", "practice"]);
  assert.equal(areaLabel("practice"), "Practice");
  assert.equal(areaLabel("home"), "Home");
});

test("dates print in Eastern time the way the board does", () => {
  assert.equal(formatShortDay("2026-10-25T13:14:00Z"), "Sun 10-25");
  assert.equal(formatShortDay("2026-10-26T03:30:00Z"), "Sun 10-25"); // 11:30 PM on the 25th in New York
  assert.equal(formatEtDayTime("2026-10-25T13:14:00Z"), "Sun 2026-10-25 09:14 ET");
  assert.equal(formatEtDayTimeShort("2026-10-26T14:12:00Z"), "Mon 10:12 ET");
  assert.equal(formatEtDayTimeShort("not a date"), "—");
  assert.equal(formatEtDayTime("not a date"), "—");
  assert.equal(formatShortDay("not a date"), "—");
});

test("the timeline reads Open, In progress, Fixed, with the agent chip only where an agent acted", () => {
  const entries = timeline([opened, started, fixed]);
  assert.deepEqual(
    entries.map(({ label, agent, note, current }) => ({ label, agent, note, current })),
    [
      { label: "Open · Sun 2026-10-25 09:14 ET", agent: null, note: null, current: false },
      { label: "In progress · Mon 2026-10-26 08:02 ET", agent: "picked up by Claude Code", note: null, current: false },
      { label: "Fixed · Thu 2026-10-29 16:40 ET", agent: "Claude Code · commit 1a2b3c4", note: null, current: true },
    ],
  );
});

test("an owner's fix, reason and duplicate read as plain notes, not agent chips", () => {
  const [, ownerFix, wontFix, dupe, reopened] = timeline([
    opened,
    { ...fixed, actor: "owner", note: "PR #12 · shipped with the day list work" },
    { ...fixed, actor: "owner", to_status: "wont_fix", note: "The replay clock is already in the top bar" },
    { ...fixed, actor: "owner", to_status: "duplicate", note: "Duplicate of F-009 · same cause" },
    { ...started, actor: "hermes", from_status: "in_progress", to_status: "open" },
  ]);
  assert.deepEqual([ownerFix!.agent, ownerFix!.note], [null, "PR #12 · shipped with the day list work"]);
  assert.deepEqual([wontFix!.agent, wontFix!.note], [null, "The replay clock is already in the top bar"]);
  assert.deepEqual([dupe!.agent, dupe!.note], [null, "Duplicate of F-009 · same cause"]);
  assert.equal(reopened!.agent, "put back by Hermes");
});

test("a fix reference reads as a commit or stays a pull request", () => {
  assert.equal(describeFix("1a2b3c4"), "commit 1a2b3c4");
  assert.equal(describeFix("PR #12"), "PR #12");
  assert.equal(describeFix("1a2b3c4 and PR #12"), "1a2b3c4 and PR #12");
});

test("the agent line is purple only for Claude Code or Hermes, and says who is working on it or what fixed it", () => {
  const now = new Date("2026-10-26T14:02:00Z");
  assert.deepEqual(agentLine(detail("in_progress", [opened, started]), now), { tone: "ai", text: "Claude Code is working on this · updated 2 hr ago" });
  assert.deepEqual(agentLine(detail("in_progress", [opened, { ...started, actor: "hermes" }]), now), { tone: "ai", text: "Hermes is working on this · updated 2 hr ago" });
  assert.equal(agentLine(detail("in_progress", [opened, { ...started, actor: "owner" }]), now), null);
  assert.deepEqual(agentLine(detail("fixed", [opened, started, fixed], { fix_ref: "1a2b3c4" }), now), { tone: "ai", text: "Fixed in 1a2b3c4 · shipped Thu 2026-10-29" });
  assert.deepEqual(agentLine(detail("fixed", [opened, { ...fixed, actor: "owner" }], { fix_ref: "PR #12" }), now), { tone: "plain", text: "Fixed in PR #12 · shipped Thu 2026-10-29" });
  assert.deepEqual(agentLine(detail("wont_fix", [opened, { ...fixed, actor: "owner", to_status: "wont_fix", note: "Already in the top bar" }]), now), { tone: "plain", text: "Won't fix · Already in the top bar" });
  assert.deepEqual(agentLine(detail("duplicate", [opened, { ...fixed, actor: "owner", to_status: "duplicate", note: "Duplicate of F-009" }], { duplicate_of: 9 }), now), { tone: "plain", text: "Duplicate of F-009" });
  assert.equal(agentLine(detail("open", [opened]), now), null);
  assert.equal(agentLine(detail("fixed", [opened]), now), null); // events that do not reach the status say nothing
});

test("a report was created when its first event was written", () => {
  assert.equal(createdAt({ events: [opened, started], captured_at: "2026-10-25T13:13:00Z" }), "2026-10-25T13:14:00Z");
  assert.equal(createdAt({ events: [], captured_at: "2026-10-25T13:13:00Z" }), "2026-10-25T13:13:00Z");
});

test("a bug shows its severity scale and a missing one shows a dash", () => {
  assert.equal(severityText("P2"), "P2 · wrong, with a workaround");
  assert.equal(severityText("P0"), "P0 · wrong money or data");
  assert.equal(severityText(null), "—");
});

test("only web addresses become links", () => {
  assert.equal(safeHref("https://trading.tobytran.dev/practice"), "https://trading.tobytran.dev/practice");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("//evil.example/x"), null);
  assert.equal(linkHost("https://trading.tobytran.dev/practice/day?id=5"), "trading.tobytran.dev");
  assert.equal(linkHost("not a url"), "not a url");
});

test("sizes print the way the board does, and a screenshot is checked before it goes up", () => {
  assert.equal(formatBytes(412 * 1024), "412 KB");
  assert.equal(formatBytes(Math.round(8.4 * 1024 * 1024)), "8.4 MB");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(checkScreenshot({ type: "image/png", size: 412 * 1024 }), null);
  assert.equal(checkScreenshot({ type: "image/webp", size: 5 * 1024 * 1024 }), null); // exactly 5 MB is allowed
  assert.equal(
    checkScreenshot({ type: "image/png", size: Math.round(8.4 * 1024 * 1024) }),
    "Upload failed · this file is 8.4 MB, the limit is 5 MB",
  );
  assert.equal(checkScreenshot({ type: "application/pdf", size: 1000 }), "Upload failed · only PNG, JPEG or WebP screenshots can be attached");
  assert.equal(checkScreenshot({ type: "image/gif", size: 1000 }), "Upload failed · only PNG, JPEG or WebP screenshots can be attached");
  assert.equal(checkScreenshot({ type: "image/png", size: 0 }), "Upload failed · this file is empty");
});

test("a refused upload says why in plain words, and every failure starts with Upload failed", () => {
  assert.equal(uploadFailureText(new DeskApiError("http", 413, {})), "Upload failed · this file is over the 5 MB limit");
  assert.equal(uploadFailureText(new DeskApiError("http", 415, {})), "Upload failed · only PNG, JPEG or WebP screenshots can be attached");
  assert.equal(
    uploadFailureText(new DeskApiError("http", 409, { detail: "You already have 6 screenshots waiting; send the report or remove one" })),
    "Upload failed · you already have 6 screenshots waiting; send the report or remove one",
  );
  assert.equal(uploadFailureText(new DeskApiError("http", 422, { problems: [{ path: "file", message: "Attach a screenshot in the field named file" }] })), "Upload failed · attach a screenshot in the field named file");
  assert.equal(uploadFailureText(new DeskApiError("unauthenticated", 401)), "Upload failed · you were signed out, sign in again and retry");
  assert.equal(uploadFailureText(new DeskApiError("http", 500, {})), "Upload failed · the connection dropped, try again");
  assert.equal(uploadFailureText(new Error("boom")), "Upload failed · the connection dropped, try again");
});

test("a failed remove says plainly that the screenshot is still there", () => {
  assert.equal(removeFailureText(new DeskApiError("http", 409, {})), "Could not remove this screenshot · it is already on a report and stays with it");
  assert.equal(removeFailureText(new DeskApiError("http", 404, {})), "Could not remove this screenshot · it is no longer in your uploads, so it cannot be removed here");
  assert.equal(removeFailureText(new DeskApiError("unauthenticated", 401)), "Could not remove this screenshot · you were signed out, sign in again and retry");
  assert.equal(removeFailureText(new DeskApiError("http", 500, {})), "Could not remove this screenshot · the connection dropped, try again");
  assert.equal(removeFailureText(new Error("boom")), "Could not remove this screenshot · the connection dropped, try again");
});

const upload = (status: UploadItem["status"], extra: Partial<UploadItem> = {}): UploadItem => ({
  key: `k-${status}-${Math.random()}`,
  filename: "day-list.png",
  size: 412 * 1024,
  contentType: "image/png",
  status,
  progress: status === "done" ? 100 : 40,
  attachmentId: status === "done" ? 3 : null,
  failure: status === "failed" ? "Upload failed · the connection dropped, try again" : null,
  ...extra,
});
const draft = (extra: Partial<FormDraft> = {}): FormDraft => ({ ...emptyFields(), title: "Day list marks Day 4 done", body: "It turns green too early.", uploads: [], ...extra });

test("Send says why it is off, in the order the board shows: required text, links, uploading, failed", () => {
  assert.equal(sendReason(draft({ title: "", body: "" })), "Reason: a title and a description are required.");
  assert.equal(sendReason(draft({ title: "  " })), "Reason: a title is required.");
  assert.equal(sendReason(draft({ body: "" })), "Reason: a description is required.");
  assert.equal(sendReason(draft({ links: [{ label: "Chart", url: "ftp://x" }] })), "Reason: link 1 needs a web address that starts with http:// or https://.");
  assert.equal(sendReason(draft({ uploads: [upload("uploading")] })), "Reason: 1 screenshot is still uploading · you can send when it finishes.");
  assert.equal(sendReason(draft({ uploads: [upload("uploading"), upload("uploading")] })), "Reason: 2 screenshots are still uploading · you can send when they finish.");
  assert.equal(sendReason(draft({ uploads: [upload("failed")] })), "Reason: 1 screenshot failed to upload · retry or remove it.");
  assert.equal(sendReason(draft({ uploads: [upload("failed"), upload("failed")] })), "Reason: 2 screenshots failed to upload · retry or remove them.");
  assert.equal(sendReason(draft({ uploads: [upload("uploading"), upload("failed")] })), "Reason: 1 screenshot is still uploading · you can send when it finishes.");
  assert.equal(sendReason(draft({ uploads: [upload("done")] })), null);
  assert.equal(sendReason(draft()), null);
  assert.match(READY_TEXT, /^Ready · /);
});

test("a blank link row never blocks Send and is never sent", () => {
  const links = [{ label: "", url: "" }, { label: "Chart screenshot", url: " https://trading.tobytran.dev/practice/day?id=5 " }, { label: "", url: "" }];
  assert.equal(sendReason(draft({ links })), null);
  assert.deepEqual(filledLinks(links), [{ label: "Chart screenshot", url: " https://trading.tobytran.dev/practice/day?id=5 " }]);
  assert.equal(sendReason(draft({ links: [{ label: "only a label", url: "" }] })), "Reason: link 1 needs a web address that starts with http:// or https://.");
});

const captured = { screen: "Practice · Day list", route: "/practice/day?id=5", appVersion: "desk-2026.10.26", capturedAt: "2026-10-26T14:12:00.000Z", context: { day_list_id: 5 } };

test("the body of a bug carries severity, expectation, links and the finished screenshots only", () => {
  const body = toCreateBody(
    draft({
      kind: "bug",
      severity: "P1",
      title: "  Day list marks Day 4 done  ",
      expected: " It should stay In progress ",
      links: [{ label: "Chart screenshot", url: "https://trading.tobytran.dev/x" }, { label: "", url: "https://trading.tobytran.dev/y" }, { label: "", url: "" }],
      uploads: [upload("done", { attachmentId: 3 }), upload("uploading"), upload("failed"), upload("done", { attachmentId: 9 })],
    }),
    captured,
  );
  assert.deepEqual(body, {
    kind: "bug",
    severity: "P1",
    title: "Day list marks Day 4 done",
    body: "It turns green too early.",
    expected: "It should stay In progress",
    screen: "Practice · Day list",
    route: "/practice/day?id=5",
    app_version: "desk-2026.10.26",
    context: { day_list_id: 5 },
    captured_at: "2026-10-26T14:12:00.000Z",
    links: [{ label: "Chart screenshot", url: "https://trading.tobytran.dev/x" }, { url: "https://trading.tobytran.dev/y" }],
    attachment_ids: [3, 9],
  });
});

test("a feature request has no severity and no expectation, even if the bug fields were filled before she switched", () => {
  const body = toCreateBody(draft({ kind: "request", severity: "P0", expected: "left over" }), captured);
  assert.equal("severity" in body, false);
  assert.equal("expected" in body, false);
  assert.equal(body.kind, "request");
});

test("a refused Send says the API's own sentence, or a generic one", () => {
  assert.equal(sendError(new DeskApiError("http", 422, { problems: [{ path: "title", message: "Title is too long" }, { path: "body", message: "Say what happened" }] })), "Title is too long · Say what happened");
  assert.equal(sendError(new DeskApiError("http", 409, { detail: "A report holds at most 6 screenshots" })), "A report holds at most 6 screenshots");
  assert.equal(sendError(new DeskApiError("http", 500, {})), "Couldn't send the report · Try again");
  assert.equal(sendError(new TypeError("Failed to fetch")), "Couldn't send the report · Try again");
});

test("the reporter shows as one uppercase initial, whatever the API sends", () => {
  assert.equal(reporterInitial("dashify.tt"), "D");
  assert.equal(reporterInitial("W"), "W");
  assert.equal(reporterInitial("  toby tran"), "T");
  assert.equal(reporterInitial("\u{1D4D0}lice"), "\u{1D4D0}"); // a character outside the BMP is not cut in half
  assert.equal(reporterInitial(""), "—");
});
