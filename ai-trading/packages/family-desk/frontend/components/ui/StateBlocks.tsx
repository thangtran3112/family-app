"use client";

import { useState, type ReactNode } from "react";
import { loadErrorText } from "@/lib/desk/freshness";
import { queryView, retryLabel } from "@/lib/desk/primitivesView";
import type { DeskQueryResult } from "@/lib/desk/useDeskQuery";
import { Button } from "./Button";
import styles from "./StateBlocks.module.css";

/** "Loading chart…" skeleton block. */
export function LoadingBlock({ label, height = 160 }: { label: string; height?: number }) {
  return (
    <div className={styles.loading} style={{ minHeight: height }} role="status" aria-live="polite">
      <span className={styles.shimmer} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** A grey bar in the shape of what is coming (a title, a line, a table). One pulse for every skeleton; hidden from assistive tech. Size in px or a CSS length. */
export function Skeleton({ width, height = 12, className }: { width?: number | string; height?: number | string; className?: string }) {
  return <span className={`${styles.skeleton} ${className ?? ""}`} style={{ width, height }} aria-hidden="true" />;
}

/**
 * "Couldn't load this chart · Try again" (02l §c3), or a custom `message`. Engineering detail never shows here. While the retry runs
 * (`retrying`) the button says "Trying again" and waits.
 */
export function ErrorBlock({ subject, message, onRetry, retrying = false }: { subject?: string; message?: string; onRetry: () => void; retrying?: boolean }) {
  // The copy table ends these messages with "· Try again"; the retry button is that last phrase.
  const lead = (message ?? loadErrorText(subject ?? "page")).replace(/ · Try again$/, "");
  return (
    <div className={styles.error} role="alert">
      <span>{lead} ·</span>
      <Button size="md" loading={retrying} onClick={onRetry}>{retryLabel(retrying)}</Button>
    </div>
  );
}

/** A reason and, when there is a next step, an `action` link ("Open Settings"). `children` carry anything more (a list, a hint). */
export function EmptyBlock({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: { label: string; href: string } }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      {children && <div className={styles.emptyBody}>{children}</div>}
      {action && <Button href={action.href}>{action.label}</Button>}
    </div>
  );
}

/**
 * The loading, error and empty states of one query, so a screen writes only its ready state. `children` runs with the data. A string
 * `loading` is the label of a `LoadingBlock` of `height`; any other node replaces it (a `Skeleton` layout). The error block offers
 * retry (`subject` names what failed, or `message` replaces the copy) and says "Trying again" only while a retry runs. `empty` shows
 * instead of `children` when `isEmpty(data)` is true. Nothing is shown for a failed refresh: the old values stay.
 */
export function QueryBoundary<T>({
  query,
  loading = "Loading…",
  height,
  subject,
  message,
  error,
  empty,
  isEmpty,
  children,
}: {
  query: Pick<DeskQueryResult<T>, "data" | "error" | "loading" | "refresh">;
  loading?: ReactNode;
  height?: number;
  subject?: string;
  message?: string;
  /** Replaces the error block. */
  error?: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  const [retrying, setRetrying] = useState(false);
  // A retry is over once the query stops loading; clear the flag in the render that sees it, so the next failure starts from "Try again".
  if (retrying && !query.loading) setRetrying(false);
  const data = query.data;
  const view = queryView(query, { retrying, isEmpty: data !== null && isEmpty !== undefined && isEmpty(data) });
  switch (view) {
    case "ready":
      return <>{children(data as T)}</>;
    case "empty":
      return <>{empty}</>;
    case "loading":
      return <>{typeof loading === "string" ? <LoadingBlock label={loading} height={height} /> : loading}</>;
    default:
      return (
        <>
          {error ?? (
            <ErrorBlock
              subject={subject}
              message={message}
              retrying={view === "retrying"}
              onRetry={() => {
                setRetrying(true);
                query.refresh();
              }}
            />
          )}
        </>
      );
  }
}
