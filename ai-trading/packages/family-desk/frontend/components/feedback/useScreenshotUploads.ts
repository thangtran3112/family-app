"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteStagedScreenshot } from "@/lib/desk/feedback";
import { uploadScreenshot } from "@/lib/desk/feedbackUpload";
import { checkScreenshot, MAX_SCREENSHOTS, removeFailureText, uploadFailureText, type UploadItem } from "@/lib/desk/feedbackView";

export type ScreenshotUploads = {
  uploads: readonly UploadItem[];
  /** A sentence when files were left out (more than six), else null. */
  notice: string | null;
  add: (files: readonly File[]) => void;
  retry: (key: string) => void;
  /** Cancels an upload, or deletes a staged file on the server; a refused delete leaves the row with a sentence in `failure`. */
  remove: (key: string) => void | Promise<void>;
};

/**
 * The screenshots on the form: each file goes to the staging route as soon as it is added (drop, paste or the file picker),
 * with its own progress and its own failure row (02s §Frontend). The report is sent with the ids of the ones that finished.
 */
export function useScreenshotUploads(): ScreenshotUploads {
  const [uploads, setUploads] = useState<readonly UploadItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const removing = useRef(new Set<string>());
  const counter = useRef(0);

  const patch = useCallback((key: string, change: Partial<UploadItem>) => {
    setUploads((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  const start = useCallback(
    async (key: string, file: File) => {
      const controller = new AbortController();
      controllers.current.set(key, controller);
      patch(key, { status: "uploading", progress: 0, failure: null });
      try {
        const saved = await uploadScreenshot(file, { signal: controller.signal, onProgress: (progress) => patch(key, { progress }) });
        patch(key, { status: "done", progress: 100, attachmentId: saved.id, filename: saved.filename, size: saved.size_bytes, contentType: saved.content_type });
      } catch (error) {
        // A removed or cancelled upload is gone from the list already; there is nothing to mark.
        if (!controller.signal.aborted) patch(key, { status: "failed", failure: uploadFailureText(error) });
      } finally {
        controllers.current.delete(key);
      }
    },
    [patch],
  );

  const add = useCallback(
    (incoming: readonly File[]) => {
      const fresh: UploadItem[] = [];
      let held = uploads.length;
      let left = 0;
      for (const file of incoming) {
        if (held >= MAX_SCREENSHOTS) {
          left += 1;
          continue;
        }
        held += 1;
        counter.current += 1;
        const key = `shot-${counter.current}`;
        const failure = checkScreenshot(file);
        files.current.set(key, file);
        fresh.push({
          key,
          filename: file.name || "screenshot",
          size: file.size,
          contentType: file.type,
          status: failure ? "failed" : "uploading",
          progress: 0,
          attachmentId: null,
          failure,
        });
      }
      setNotice(left > 0 ? `A report holds at most ${MAX_SCREENSHOTS} screenshots · ${left} ${left === 1 ? "file was" : "files were"} not added.` : null);
      if (fresh.length === 0) return;
      setUploads((current) => [...current, ...fresh]);
      for (const item of fresh) {
        const file = files.current.get(item.key);
        if (item.status === "uploading" && file) void start(item.key, file);
      }
    },
    [uploads.length, start],
  );

  const retry = useCallback(
    (key: string) => {
      const file = files.current.get(key);
      if (!file) return;
      const failure = checkScreenshot(file);
      if (failure) patch(key, { status: "failed", failure });
      else void start(key, file);
    },
    [patch, start],
  );

  const drop = useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    files.current.delete(key);
    setUploads((current) => current.filter((item) => item.key !== key));
    setNotice(null);
  }, []);

  // A file that reached the server is staged there until the report is sent (or 24 hours pass), so Remove deletes it on the
  // server first and the row goes only when the server says it is gone. Any other row never left this browser.
  const remove = useCallback(
    async (key: string) => {
      const item = uploads.find((candidate) => candidate.key === key);
      if (item?.status !== "done" || item.attachmentId === null) return drop(key);
      if (removing.current.has(key)) return;
      removing.current.add(key);
      patch(key, { failure: null });
      try {
        await deleteStagedScreenshot(item.attachmentId);
        drop(key);
      } catch (error) {
        patch(key, { failure: removeFailureText(error) });
      } finally {
        removing.current.delete(key);
      }
    },
    [uploads, drop, patch],
  );

  // A screenshot pasted anywhere on the form joins the list (the clipboard's image files only; pasted text is left alone).
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (images.length > 0) add(images);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [add]);

  // Leaving the form drops any upload still going.
  useEffect(() => {
    const running = controllers.current;
    return () => {
      for (const controller of running.values()) controller.abort();
    };
  }, []);

  return { uploads, notice, add, retry, remove };
}
