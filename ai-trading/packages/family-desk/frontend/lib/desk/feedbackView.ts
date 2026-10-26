import { DeskApiError } from "../api/client.ts";
import type {
  FeedbackActor,
  FeedbackDetail,
  FeedbackEvent,
  FeedbackItem,
  FeedbackKind,
  FeedbackSeverity,
  FeedbackStatus,
} from "../feedback/schemas.ts";
import type { FeedbackQuery, FeedbackSort } from "./feedback.ts";
import { EMPTY_VALUE, formatEtDay, formatEtStamp } from "./format.ts";

// View logic for the Feedback screens (02s §Frontend): filters, labels, the status timeline, the agent lines and the
// filing form's rules. Everything here is plain text in and out, so the node tests cover it without a browser.

export const STATUSES: readonly FeedbackStatus[] = ["open", "in_progress", "fixed", "wont_fix", "duplicate"];
export const STATUS_LABEL: Record<FeedbackStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  fixed: "Fixed",
  wont_fix: "Won't fix",
  duplicate: "Duplicate",
};
/** Open, Won't fix and Duplicate are outlined chips; In progress is amber and Fixed is green (a word plus a colour). */
export type StatusTone = "neutral" | "amber" | "up";
export const statusTone = (status: FeedbackStatus): StatusTone => (status === "in_progress" ? "amber" : status === "fixed" ? "up" : "neutral");

export const KIND_LABEL: Record<FeedbackKind, string> = { bug: "Bug", request: "Request" };
export const KIND_FILTER_LABEL: Record<FeedbackKind, string> = { bug: "Bug", request: "Feature request" };

/** The `DEFECTS.md` scale verbatim (02s decision 4). `help` is the form's helper text; `short` is the detail rail's meta line. */
export const SEVERITIES: readonly { id: FeedbackSeverity; help: string; short: string }[] = [
  { id: "P0", help: "Wrong money or data, a trading figure shown as true, or a secret leak", short: "wrong money or data" },
  { id: "P1", help: "A core flow is broken and there is no workaround", short: "a core flow is broken" },
  { id: "P2", help: "Wrong or confusing, with a workaround", short: "wrong, with a workaround" },
  { id: "P3", help: "Cosmetic or copy", short: "cosmetic or copy" },
];
export const severityText = (severity: FeedbackSeverity | null): string => {
  const found = SEVERITIES.find((item) => item.id === severity);
  return found ? `${found.id} · ${found.short}` : EMPTY_VALUE;
};

export const SORTS: readonly { id: FeedbackSort; label: string }[] = [
  { id: "newest", label: "Newest" },
  { id: "updated", label: "Recently updated" },
  { id: "oldest", label: "Oldest" },
];

export const refOf = (id: number): string => `F-${String(id).padStart(3, "0")}`;

// ---- the dashboard's filters --------------------------------------------------------------------------------------------

export type FeedbackFilters = { kind: "" | FeedbackKind; statuses: readonly FeedbackStatus[]; area: string; q: string; sort: FeedbackSort };
export const defaultFilters = (): FeedbackFilters => ({ kind: "", statuses: STATUSES, area: "", q: "", sort: "newest" });

/** A chip turns one status on or off; turning off the last one that is on brings them all back, so the list is never empty by accident. */
export function toggleStatus(current: readonly FeedbackStatus[], status: FeedbackStatus): FeedbackStatus[] {
  const next = current.includes(status) ? current.filter((item) => item !== status) : [...current, status];
  return next.length === 0 ? [...STATUSES] : STATUSES.filter((item) => next.includes(item));
}

/** The request for the current chips: the five statuses on is "no status filter", so nothing is sent. */
export function toQuery(filters: FeedbackFilters): FeedbackQuery {
  return {
    status: filters.statuses.length === STATUSES.length ? undefined : [...filters.statuses],
    kind: filters.kind || undefined,
    area: filters.area || undefined,
    q: filters.q.trim() || undefined,
    sort: filters.sort,
  };
}

export const totalOf = (counts: Record<FeedbackStatus, number>): number => STATUSES.reduce((sum, status) => sum + counts[status], 0);

/** "Open 3 · In progress 2 · Fixed 1 · Won't fix 1 · Duplicate 1" */
export const countsText = (counts: Record<FeedbackStatus, number>): string => STATUSES.map((status) => `${STATUS_LABEL[status]} ${counts[status]}`).join(" · ");

/** "8 reports" or, with filters on, "3 of 8 reports". */
export function listFootnote(shown: number, total: number): string {
  const noun = total === 1 ? "report" : "reports";
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}

/** The area names the select offers: the ones in the list now, plus the one chosen (so it stays when it matches nothing). */
export const areaOptions = (items: readonly Pick<FeedbackItem, "area">[], chosen: string): string[] =>
  [...new Set([...items.map((item) => item.area), ...(chosen ? [chosen] : [])])].sort((a, b) => a.localeCompare(b));

/** "practice" -> "Practice"; the table prints the area the way the board does. */
export const areaLabel = (area: string): string => (area ? `${area.charAt(0).toUpperCase()}${area.slice(1)}` : EMPTY_VALUE);

// ---- dates --------------------------------------------------------------------------------------------------------------

const ET = "America/New_York";

/** "Wed 10-29": the table's Updated column. */
export function formatShortDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", month: "2-digit", day: "2-digit" }).formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.weekday} ${parts.month}-${parts.day}`;
}

/** "Sun 2026-10-25 09:14 ET" */
export function formatEtDayTime(iso: string): string {
  const stamp = formatEtStamp(iso);
  return stamp === EMPTY_VALUE ? EMPTY_VALUE : `${formatEtDay(iso)} ${stamp.slice(-5)} ET`;
}

/** "Thu 20:00 ET": the form's rail, where the full date is already in the panel beside it. */
export function formatEtDayTimeShort(iso: string): string {
  const stamp = formatEtStamp(iso);
  return stamp === EMPTY_VALUE ? EMPTY_VALUE : `${formatEtDay(iso).slice(0, 3)} ${stamp.slice(-5)} ET`;
}

/** "just now" / "12 min ago" / "2 h ago" / "3 d ago" (the agent line). */
export function agoText(iso: string, now: Date): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return EMPTY_VALUE;
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// ---- the detail rail: timeline and agent lines --------------------------------------------------------------------------

const AGENT_NAME: Partial<Record<FeedbackActor, string>> = { "claude-code": "Claude Code", hermes: "Hermes" };
export const agentName = (actor: FeedbackActor): string | null => AGENT_NAME[actor] ?? null;

/** "1a2b3c4" -> "commit 1a2b3c4"; "PR #12" stays as it is. */
export const describeFix = (fixRef: string): string => (/^[0-9a-f]{7,40}$/i.test(fixRef.trim()) ? `commit ${fixRef.trim()}` : fixRef.trim());

export type TimelineEntry = {
  key: string;
  label: string;
  /** The current step: an amber dot and a heavier label. */
  current: boolean;
  /** Text for the agent chip (`--color-ai`), only when Claude Code or Hermes made the change. */
  agent: string | null;
  /** A muted line under the label: the owner's fix reference, the reason for Won't fix, the original of a duplicate. */
  note: string | null;
};

/** The event note is `<fix ref or "Duplicate of F-009"> · <free note>` (ai_trading/feedback.py `_event_note`). */
function splitNote(status: FeedbackStatus, note: string | null): { lead: string | null; rest: string | null } {
  if (!note) return { lead: null, rest: null };
  if (status !== "fixed" && !note.startsWith("Duplicate of ")) return { lead: null, rest: note };
  const [lead = "", ...rest] = note.split(" · ");
  return { lead: lead || null, rest: rest.join(" · ") || null };
}

export function timeline(events: readonly FeedbackEvent[]): TimelineEntry[] {
  return events.map((event, index) => {
    const agent = agentName(event.actor);
    const { lead, rest } = splitNote(event.to_status, event.note);
    let chip: string | null = null;
    let note: string | null = null;
    if (event.to_status === "fixed" && lead) {
      if (agent) chip = `${agent} · ${describeFix(lead)}`;
      else note = describeFix(lead);
      if (rest) note = note ? `${note} · ${rest}` : rest;
    } else if (event.to_status === "in_progress" && agent) {
      chip = `picked up by ${agent}`;
      note = rest;
    } else if (event.to_status === "open" && event.from_status !== null && agent) {
      chip = `put back by ${agent}`;
      note = rest;
    } else {
      note = lead ? (rest ? `${lead} · ${rest}` : lead) : rest;
    }
    return {
      key: `${event.at}-${index}`,
      label: `${STATUS_LABEL[event.to_status]} · ${formatEtDayTime(event.at)}`,
      current: index === events.length - 1,
      agent: chip,
      note,
    };
  });
}

export type AgentLine = { tone: "ai" | "plain"; text: string };

/**
 * What the rail says under the title once somebody has acted on the report. The `--color-ai` tone is only for lines about
 * Claude Code or Hermes (02s Frontend, States); the owner's own fix or reason reads as plain text.
 */
export function agentLine(detail: Pick<FeedbackDetail, "status" | "fix_ref" | "updated_at" | "events" | "duplicate_of">, now: Date): AgentLine | null {
  const last = detail.events.at(-1);
  if (!last || last.to_status !== detail.status) return null;
  const agent = agentName(last.actor);
  if (detail.status === "in_progress") {
    return agent ? { tone: "ai", text: `${agent} is working on this · updated ${agoText(detail.updated_at, now)}` } : null;
  }
  if (detail.status === "fixed" && detail.fix_ref) {
    return { tone: agent ? "ai" : "plain", text: `Fixed in ${detail.fix_ref} · shipped ${formatEtDay(last.at)}` };
  }
  if (detail.status === "wont_fix") {
    const { rest } = splitNote("wont_fix", last.note);
    return { tone: "plain", text: rest ? `Won't fix · ${rest}` : "Won't fix" };
  }
  if (detail.status === "duplicate" && detail.duplicate_of) return { tone: "plain", text: `Duplicate of ${refOf(detail.duplicate_of)}` };
  return null;
}

/** The creation event is the report's created time; older rows without one fall back to when the context was captured. */
export const createdAt = (detail: Pick<FeedbackDetail, "events" | "captured_at">): string => detail.events[0]?.at ?? detail.captured_at;

/** A link's host for the rail ("trading.tobytran.dev"), or the address itself when it does not parse. */
export function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Only web addresses become links; the server checks too, but a row that was stored some other way is never clickable. */
export const safeHref = (url: string): string | null => (/^https?:\/\/\S+$/i.test(url) ? url : null);

// ---- screenshots --------------------------------------------------------------------------------------------------------

export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_SCREENSHOTS = 6;
export const MAX_LINKS = 10;
export const SCREENSHOT_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

/** "412 KB" / "8.4 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "PNG" for the row's second line. */
export const typeLabel = (contentType: string): string => (contentType.split("/")[1] ?? "").replace("jpeg", "jpg").toUpperCase() || EMPTY_VALUE;

const LIMIT_TEXT = "5 MB";

/** The failure sentence for a file the browser already knows is wrong, or null when it may go up. */
export function checkScreenshot(file: { type: string; size: number }): string | null {
  if (!SCREENSHOT_TYPES.includes(file.type)) return "Upload failed · only PNG, JPEG or WebP screenshots can be attached";
  if (file.size > MAX_SCREENSHOT_BYTES) return `Upload failed · this file is ${formatBytes(file.size)}, the limit is ${LIMIT_TEXT}`;
  if (file.size === 0) return "Upload failed · this file is empty";
  return null;
}

/** Plain words for a refused or dropped upload; the server's own sentence is used where it sends one. */
export function uploadFailureText(error: unknown): string {
  if (error instanceof DeskApiError) {
    if (error.kind === "unauthenticated") return "Upload failed · you were signed out, sign in again and retry";
    if (error.status === 413) return `Upload failed · this file is over the ${LIMIT_TEXT} limit`;
    if (error.status === 415) return "Upload failed · only PNG, JPEG or WebP screenshots can be attached";
    const sentence = error.detail ?? error.problems[0]?.message;
    if (sentence && (error.status === 409 || error.status === 422)) return `Upload failed · ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
  }
  return "Upload failed · the connection dropped, try again";
}

// ---- the filing form ----------------------------------------------------------------------------------------------------

export type UploadItem = {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  status: "uploading" | "done" | "failed";
  /** 0 to 100 while uploading. */
  progress: number;
  attachmentId: number | null;
  failure: string | null;
};

export type LinkDraft = { label: string; url: string };

/** What she types and picks; the uploads have their own state because they finish on their own. */
export type FormFields = {
  kind: FeedbackKind;
  title: string;
  body: string;
  expected: string;
  severity: FeedbackSeverity;
  links: readonly LinkDraft[];
};

export type FormDraft = FormFields & { uploads: readonly UploadItem[] };

export const TITLE_LIMIT = 120;
export const BODY_LIMIT = 4000;

/** A bug, P2 ("wrong or confusing, with a workaround") picked as the common case, and one empty link row open. */
export const emptyFields = (): FormFields => ({ kind: "bug", title: "", body: "", expected: "", severity: "P2", links: [{ label: "", url: "" }] });

/** "What happened?" for a bug and "What should it do?" for a request (02s Deliverable 2). */
export const bodyLabel = (kind: FeedbackKind): string => (kind === "bug" ? "What happened?" : "What should it do?");

export const isWebAddress = (url: string): boolean => /^https?:\/\/\S+$/i.test(url.trim());

/** Rows she has not typed in are ignored, so the empty row the form keeps open never blocks Send. */
export const filledLinks = (links: readonly LinkDraft[]): LinkDraft[] => links.filter((link) => link.label.trim() !== "" || link.url.trim() !== "");

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The truthful reason Send is off, as the board words it, or null when the report can go. */
export function sendReason(draft: FormDraft): string | null {
  const title = draft.title.trim() !== "";
  const body = draft.body.trim() !== "";
  if (!title || !body) {
    if (!title && !body) return "Reason: a title and a description are required.";
    return title ? "Reason: a description is required." : "Reason: a title is required.";
  }
  const links = filledLinks(draft.links);
  for (const [index, link] of links.entries()) {
    if (!isWebAddress(link.url)) return `Reason: link ${index + 1} needs a web address that starts with http:// or https://.`;
  }
  const uploading = draft.uploads.filter((item) => item.status === "uploading").length;
  if (uploading > 0) {
    return `Reason: ${uploading} ${plural(uploading, "screenshot is", "screenshots are")} still uploading · you can send when ${plural(uploading, "it finishes", "they finish")}.`;
  }
  const failed = draft.uploads.filter((item) => item.status === "failed").length;
  if (failed > 0) return `Reason: ${failed} ${plural(failed, "screenshot", "screenshots")} failed to upload · retry or remove ${plural(failed, "it", "them")}.`;
  return null;
}

export const READY_TEXT = "Ready · every required field is filled and nothing is uploading.";

export type CreateBody = {
  kind: FeedbackKind;
  severity?: FeedbackSeverity;
  title: string;
  body: string;
  expected?: string;
  screen: string;
  route: string;
  app_version: string;
  context: Record<string, unknown>;
  captured_at: string;
  links: { label?: string; url: string }[];
  attachment_ids: number[];
};

export type CapturedForSend = { screen: string; route: string; appVersion: string; capturedAt: string; context: Record<string, unknown> };

/** The POST body. A request has no severity or expectation; blank link rows and failed uploads are left out. */
export function toCreateBody(draft: FormDraft, captured: CapturedForSend): CreateBody {
  const bug = draft.kind === "bug";
  const expected = draft.expected.trim();
  return {
    kind: draft.kind,
    ...(bug ? { severity: draft.severity } : {}),
    title: draft.title.trim(),
    body: draft.body.trim(),
    ...(bug && expected ? { expected } : {}),
    screen: captured.screen,
    route: captured.route,
    app_version: captured.appVersion,
    context: captured.context,
    captured_at: captured.capturedAt,
    links: filledLinks(draft.links).map((link) => ({ ...(link.label.trim() ? { label: link.label.trim() } : {}), url: link.url.trim() })),
    attachment_ids: draft.uploads.flatMap((item) => (item.status === "done" && item.attachmentId !== null ? [item.attachmentId] : [])),
  };
}

/** Plain words for a refused Send: the API's own sentence for a field problem, else a generic one. */
export function sendError(error: unknown): string {
  if (error instanceof DeskApiError && error.kind === "http") {
    if (error.problems.length > 0) return error.problems.map((problem) => problem.message).join(" · ");
    if (error.detail && (error.status === 409 || error.status === 403)) return error.detail;
  }
  return "Couldn't send the report · Try again";
}
