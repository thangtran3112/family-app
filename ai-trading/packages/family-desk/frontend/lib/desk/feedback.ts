import { z } from "zod";
import { FeedbackDetailSchema, FeedbackListSchema, type FeedbackKind, type FeedbackStatus } from "../feedback/schemas.ts";
import type { CreateBody } from "./feedbackView.ts";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "./api.ts";

// Loaders for `/api/desk/feedback` (02s §API surface): one function per route the screens use. Status is read-only here
// (v1): agents move it through the backend CLI, and the screens show what the API returns. Screenshots go up through
// lib/desk/feedbackUpload.ts, which reports progress; the bytes come back from `screenshotUrl`.

export type FeedbackSort = "newest" | "updated" | "oldest";
export type FeedbackQuery = { status?: FeedbackStatus[]; kind?: FeedbackKind; area?: string; q?: string; sort?: FeedbackSort; limit?: number };

/** `status` repeats (`status=open&status=fixed`); every other filter is a single value, left out when unset. */
export function feedbackListPath(query: FeedbackQuery = {}): string {
  const base = deskPath("/feedback", { kind: query.kind, area: query.area, q: query.q, sort: query.sort, limit: query.limit });
  const statuses = (query.status ?? []).map((status) => `status=${status}`).join("&");
  return statuses ? `${base}${base.includes("?") ? "&" : "?"}${statuses}` : base;
}

export const loadFeedback = (query: FeedbackQuery = {}, options?: RequestOptions) =>
  clientOf(options)(feedbackListPath(query), FeedbackListSchema, readInit(options));

export const loadFeedbackReport = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/feedback/${id}`), FeedbackDetailSchema, readInit(options));

/** Files a report. The answer is the new report, with its `F-nnn` id. */
export const createFeedbackReport = (body: CreateBody, options?: RequestOptions) =>
  clientOf(options)(deskPath("/feedback"), FeedbackDetailSchema, jsonInit("POST", body, options));

/** Removes a staged screenshot (the form's Remove). The answer is an empty 204; a file already on a report is a 409. */
export const deleteStagedScreenshot = (attachmentId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/feedback/attachments/${attachmentId}`), z.undefined(), { method: "DELETE", signal: options?.signal });

/** The screenshot's bytes (an `<img>` or a link): same origin, behind the Desk's own sign-in, never a third-party host. */
export const screenshotUrl = (attachmentId: number): string => `/api/desk/feedback/attachments/${attachmentId}`;
