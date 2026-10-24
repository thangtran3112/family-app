"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ScreenerFilter, ScreenerFilterDetail } from "@/lib/api/schemas";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { COPY } from "@/lib/desk/freshness";
import { createFilter, deleteFilter, type ScreenerSession } from "@/lib/desk/screener";
import { describeSpec } from "@/lib/spec/describe";
import { parseFilterSpec } from "@/lib/spec/parse";
import styles from "./screener.module.css";

const SESSIONS: { value: ScreenerSession; label: string }[] = [
  { value: "regular", label: "Regular" },
  { value: "extended", label: "Extended" },
];

type Action = "save" | "delete";

function LockGlyph() {
  return (
    <svg className={styles.lock} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
    </svg>
  );
}

export function FilterHeader({
  filter,
  detail,
  session,
  onSession,
  delayed,
}: {
  filter: ScreenerFilter;
  detail: ScreenerFilterDetail | null;
  session: ScreenerSession;
  onSession: (session: ScreenerSession) => void;
  /** The scan is delayed 15 min: shown as a pill next to the title. */
  delayed: boolean;
}) {
  const router = useRouter();
  const { invalidate } = useDeskUi();
  const [pending, setPending] = useState<Action | null>(null);
  const [failed, setFailed] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState(false);
  const rule = detail ? parseFilterSpec(detail.spec) : null;

  async function run(action: Action, task: () => Promise<void>) {
    setPending(action);
    setFailed(null);
    try {
      await task();
    } catch {
      setPending(null);
      setFailed(action);
    }
  }

  const saveCopy = () =>
    run("save", async () => {
      const copy = await createFilter({ copy_of: filter.id });
      invalidate("filters");
      router.push(`/screener/filters?id=${copy.id}`);
    });
  const remove = () =>
    run("delete", async () => {
      await deleteFilter(filter.id);
      invalidate("filters");
      router.push("/screener");
    });

  return (
    <header className={styles.head}>
      <div className={styles.titleBlock}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>
            {filter.read_only && <LockGlyph />}
            {filter.name}
            {filter.read_only && <span className={styles.srOnly}> Read-only</span>}
          </h1>
          {delayed && <span className={styles.pill}>{COPY.scanDelayed}</span>}
        </div>
        {rule && <p className={styles.rule}>{describeSpec(rule)}</p>}
      </div>
      <div className={styles.controls}>
        <div role="group" aria-label="Session" className={styles.segmented}>
          {SESSIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={styles.segment}
              aria-pressed={session === item.value}
              onClick={() => onSession(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <a href={`/screener/filters?id=${filter.id}`} className={styles.button}>Edit</a>
        {filter.read_only ? (
          <>
            <button type="button" className={`${styles.button} ${styles.accent}`} disabled={pending !== null} onClick={saveCopy}>
              {pending === "save" ? "Saving…" : "Save as my filter"}
            </button>
            {failed === "save" && (
              <span role="alert" className={styles.error}>
                {"Couldn't save the copy · "}
                <button type="button" className={styles.link} onClick={saveCopy}>Try again</button>
              </span>
            )}
          </>
        ) : confirming ? (
          <span className={styles.confirm}>
            Delete this filter?
            <button type="button" className={`${styles.button} ${styles.danger}`} disabled={pending !== null} onClick={remove}>
              {pending === "delete" ? "Deleting…" : "Delete"}
            </button>
            <button type="button" className={styles.button} onClick={() => setConfirming(false)}>Keep</button>
            {failed === "delete" && (
              <span role="alert" className={styles.error}>
                {"Couldn't delete this filter · "}
                <button type="button" className={styles.link} onClick={remove}>Try again</button>
              </span>
            )}
          </span>
        ) : (
          <button type="button" className={styles.button} onClick={() => setConfirming(true)}>Delete</button>
        )}
        <a href={`/alerts/new?from=filter:${filter.id}`} className={styles.link}>Alert on this filter</a>
      </div>
    </header>
  );
}
