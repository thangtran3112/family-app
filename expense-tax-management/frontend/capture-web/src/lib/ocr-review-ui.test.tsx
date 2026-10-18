// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OcrReviewForm } from "../components/ocr-review-form";
import { CaptureApiError } from "./api";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const review = {
  schemaVersion: 1 as const,
  jobId: "job-1",
  fileId: "file-1",
  jobVersion: 4,
  fields: {
    merchant: "Prefilled shop",
    total: "12.00",
    currency: "USD",
    incurredOn: "2026-10-18",
    taxAmount: "1.00",
  },
  issues: ["tax_missing" as const],
  previewUrl: "/preview",
  previewExpiresAt: "2026-10-18T00:16:00.000Z",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:01:00.000Z",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function renderForm(overrides: Partial<React.ComponentProps<typeof OcrReviewForm>> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<OcrReviewForm
      review={review}
      onComplete={vi.fn().mockResolvedValue(undefined)}
      onReload={vi.fn().mockResolvedValue(review)}
      onRemove={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />);
  });
  return container;
}

function change(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("OCR review form", () => {
  it("marks invalid fields with aria text and focuses the error summary", async () => {
    const view = await renderForm({
      review: {
        ...review,
        fields: { ...review.fields, total: null, incurredOn: null, taxAmount: null },
      },
    });
    const total = view.querySelector<HTMLInputElement>("[name=total]")!;
    const summary = view.querySelector<HTMLElement>("[role=alert]")!;

    expect(total.getAttribute("aria-invalid")).toBe("true");
    expect(total.getAttribute("aria-describedby")).toBe("total-error");
    expect(view.querySelector("#total-error")?.textContent).toContain("Total");
    expect(view.querySelector("#total-error svg")).not.toBeNull();
    expect(document.activeElement).toBe(summary);
    expect(view.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
  });

  it("keeps valid OCR-prefilled fields editable", async () => {
    const view = await renderForm();
    const merchant = view.querySelector<HTMLInputElement>("[name=merchant]")!;
    expect(merchant.value).toBe("Prefilled shop");

    await act(async () => change(merchant, "Edited shop"));

    expect(merchant.value).toBe("Edited shop");
    expect(merchant.readOnly).toBe(false);
    expect(view.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(false);
  });

  it.each([409, 412])("reloads conflict status %s while retaining typed edits", async (status) => {
    const onComplete = vi.fn().mockRejectedValue(new CaptureApiError("conflict", status));
    const onReload = vi.fn().mockResolvedValue({ ...review, jobVersion: 5 });
    const view = await renderForm({ onComplete, onReload });
    const merchant = view.querySelector<HTMLInputElement>("[name=merchant]")!;
    await act(async () => change(merchant, "Typed reconciliation"));

    await act(async () => {
      view.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onReload).toHaveBeenCalled();
    expect(merchant.value).toBe("Typed reconciliation");
    expect(view.textContent).toContain("changed on another device");
  });
});
