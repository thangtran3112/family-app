"use client";

import type { CaptureOcrCompleteRequestV1, CaptureOcrReviewDetailV1 } from "@expense-tax/contracts";
import { useAuth, useOrganization } from "@clerk/nextjs";
import { AlertCircle, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  CaptureApiError,
  completeOcrReview,
  deleteReceiptFile,
  fetchOcrReview,
} from "../lib/api";
import {
  buildCompletionRequest,
  formValuesFromReview,
  validateOcrReview,
  removeReviewReceipt,
  type OcrReviewValues,
} from "../lib/ocr-review";
import { listQueue, removeQueue, updateQueue } from "../lib/queue";
import { readSession } from "../lib/session";

export interface OcrReviewFormProps {
  review: CaptureOcrReviewDetailV1;
  onComplete(request: CaptureOcrCompleteRequestV1): Promise<void>;
  onReload(): Promise<CaptureOcrReviewDetailV1>;
  onRemove(): Promise<void>;
}

interface FieldProps {
  name: keyof Pick<OcrReviewValues, "merchant" | "total" | "currency" | "incurredOn" | "taxAmount">;
  label: string;
  value: string;
  error?: string;
  type?: "text" | "date";
  disabled?: boolean;
  onChange(value: string): void;
}

function Field({ name, label, value, error, type = "text", disabled, onChange }: FieldProps) {
  const errorId = `${name}-error`;
  return (
    <label className={`review-field${error ? " invalid" : ""}`}>
      <span>{label}</span>
      <input
        name={name}
        type={type}
        value={value}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && <small id={errorId} className="field-error"><AlertCircle size={16} aria-hidden="true" />{error}</small>}
    </label>
  );
}

export function OcrReviewForm({ review, onComplete, onReload, onRemove }: OcrReviewFormProps) {
  const [values, setValues] = useState(() => formValuesFromReview(review.fields));
  const [jobVersion, setJobVersion] = useState(review.jobVersion);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const focusedInitialErrors = useRef(false);
  const errors = useMemo(() => validateOcrReview(values), [values]);
  const errorEntries = Object.entries(errors);

  useEffect(() => {
    if (errorEntries.length > 0 && !focusedInitialErrors.current) {
      focusedInitialErrors.current = true;
      summaryRef.current?.focus();
    }
  }, [errorEntries.length]);

  function set<K extends keyof OcrReviewValues>(key: K, value: OcrReviewValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (errorEntries.length > 0) {
      summaryRef.current?.focus();
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await onComplete(buildCompletionRequest(values, jobVersion));
    } catch (error) {
      if (error instanceof CaptureApiError && (error.status === 409 || error.status === 412)) {
        const latest = await onReload();
        setJobVersion(latest.jobVersion);
        setMessage("This review changed on another device. Server state reloaded; your typed values are preserved.");
      } else {
        setMessage(error instanceof Error ? error.message : "Could not save review");
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setMessage(null);
    try {
      await onRemove();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove receipt");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-layout">
      <iframe className="receipt-preview" src={review.previewUrl} title="Receipt preview" />
      <form className="review-form" noValidate onSubmit={(event) => void submit(event)}>
        {errorEntries.length > 0 && (
          <div ref={summaryRef} className="error-summary" role="alert" tabIndex={-1}>
            <strong>Check the highlighted fields</strong>
            <span>{errorEntries.length} field{errorEntries.length === 1 ? "" : "s"} need attention.</span>
          </div>
        )}
        {message && <div className="inline-error" role="status">{message}</div>}
        <Field name="merchant" label="Merchant" value={values.merchant} error={errors.merchant} onChange={(value) => set("merchant", value)} />
        <Field name="total" label="Total" value={values.total} error={errors.total} onChange={(value) => set("total", value)} />
        <Field name="currency" label="Currency" value={values.currency} error={errors.currency} onChange={(value) => set("currency", value.toUpperCase())} />
        <Field name="incurredOn" label="Date" type="date" value={values.incurredOn} error={errors.incurredOn} onChange={(value) => set("incurredOn", value)} />
        <Field name="taxAmount" label="Tax" value={values.taxAmount} error={errors.taxAmount} disabled={values.noTax} onChange={(value) => set("taxAmount", value)} />
        <label className="no-tax-choice">
          <input type="checkbox" checked={values.noTax} onChange={(event) => set("noTax", event.target.checked)} />
          <span>No tax</span>
        </label>
        <div className="review-actions">
          <button className="primary" type="submit" disabled={busy || errorEntries.length > 0}>Save expense</button>
          <button type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={18} aria-hidden="true" />Remove</button>
        </div>
      </form>
    </div>
  );
}

export function OcrReviewScreen({ jobId }: { jobId: string }) {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const router = useRouter();
  const [review, setReview] = useState<CaptureOcrReviewDetailV1 | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const session = readSession();
    if (!session) throw new Error("Capture session unavailable");
    const loaded = await fetchOcrReview(session, jobId, getToken, organization?.id);
    setReview(loaded);
    return loaded;
  }

  useEffect(() => {
    let active = true;
    const session = readSession();
    if (!session) {
      void Promise.resolve().then(() => { if (active) setError("Capture session unavailable"); });
      return () => { active = false; };
    }
    void fetchOcrReview(session, jobId, getToken, organization?.id).then(
      (loaded) => {
        if (active) {
          setReview(loaded);
          setError(null);
        }
      },
      (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load review"); },
    );
    return () => { active = false; };
  }, [getToken, jobId, organization?.id]);

  if (error) return <div className="inline-error" role="alert">{error}</div>;
  if (!review) return <p>Loading review…</p>;

  return (
    <>
      <header className="page-head review-head">
        <div>
          <p className="kicker">Incomplete scan</p>
          <h1>Review receipt</h1>
          <p>Correct the highlighted fields before saving.</p>
        </div>
        <Link href="/queue">Back to queue</Link>
      </header>
      <OcrReviewForm
        review={review}
        onReload={load}
        onComplete={async (request) => {
          const session = readSession();
          if (!session) throw new Error("Capture session unavailable");
          await completeOcrReview(session, jobId, request, `capture:${jobId}:complete`, getToken, organization?.id);
          const local = (await listQueue()).find((item) => item.jobId === jobId);
          if (local) await updateQueue({ ...local, status: "saved", progress: 100, error: null });
          router.push("/queue");
        }}
        onRemove={async () => {
          if (!window.confirm("Remove this receipt permanently?")) return;
          const session = readSession();
          if (!session) throw new Error("Capture session unavailable");
          const local = (await listQueue()).find((item) => item.jobId === jobId);
          await removeReviewReceipt(
            () => deleteReceiptFile(session, review.fileId, getToken, organization?.id),
            () => local ? removeQueue(local.id) : Promise.resolve(),
          );
          router.push("/queue");
        }}
      />
    </>
  );
}
