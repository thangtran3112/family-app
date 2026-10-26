import { DeskApiError, parseErrorBody } from "../api/client.ts";
import { FeedbackUploadSchema, type FeedbackUpload } from "../feedback/schemas.ts";

// A screenshot goes up as multipart form data, one file per request, to the staging route (02s §API surface). `fetch` cannot
// report how much of an upload has been sent, so this uses `XMLHttpRequest` for the progress bar. The request stays on the
// Desk's own origin and carries its sign-in cookie, like every other Desk call.

const STAGE_PATH = "/api/desk/feedback/attachments";

export type UploadOptions = {
  /** 0 to 99 while the bytes go up; the caller sets 100 when the answer arrives. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
};

export function uploadScreenshot(file: File, { onProgress, signal }: UploadOptions = {}): Promise<FeedbackUpload> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    request.open("POST", STAGE_PATH);
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    request.onload = () => {
      signal?.removeEventListener("abort", abort);
      if (request.status === 401) return reject(new DeskApiError("unauthenticated", 401));
      if (request.status < 200 || request.status >= 300) return reject(new DeskApiError("http", request.status, parseErrorBody(request.response)));
      const parsed = FeedbackUploadSchema.safeParse(request.response);
      return parsed.success ? resolve(parsed.data) : reject(new DeskApiError("malformed", request.status));
    };
    request.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(new Error("The upload connection dropped"));
    };
    request.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    if (signal?.aborted) return reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const form = new FormData();
    form.append("file", file, file.name);
    request.send(form);
  });
}
