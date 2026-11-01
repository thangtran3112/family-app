"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import type { ScreenerFilter, ScreenerFilterDetail } from "@/lib/api/schemas";
import { COPY } from "@/lib/desk/freshness";
import { createFilter, deleteFilter } from "@/lib/desk/screener";
import { describeSpec } from "@/lib/spec/describe";
import { parseFilterSpec } from "@/lib/spec/parse";
import styles from "./screener.module.css";

type Action = "save" | "delete";

/** The filter's session is part of its rule ("during regular hours"): there is no toggle, because the API runs the
 * filter's own session and nothing else (V-SCR-04). Changing it is an edit of her own copy. */
export function FilterHeader({
  filter,
  detail,
  delayed,
}: {
  filter: ScreenerFilter;
  detail: ScreenerFilterDetail | null;
  /** The scan is delayed 15 min: shown as a pill next to the title. */
  delayed: boolean;
}) {
  const router = useRouter();
  const { invalidate } = useDeskUi();
  const [pending, setPending] = useState<Action | null>(null);
  const [failed, setFailed] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const rule = detail ? parseFilterSpec(detail.spec) : null;

  async function run(action: Action, task: () => Promise<void>) {
    setPending(action);
    setFailed(null);
    try {
      await task();
    } catch {
      setFailed(action);
    } finally {
      setPending(null);
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
          <h1 className={styles.title} title={filter.name}>
            {filter.read_only && <Icon name="lock" size={12} className={styles.lock} />}
            {filter.name}
            {filter.read_only && <span className="sr-only"> Read-only</span>}
          </h1>
          {delayed && <Badge>{COPY.scanDelayed}</Badge>}
        </div>
        {rule && <p className={styles.rule}>{describeSpec(rule)}</p>}
      </div>
      <div className={styles.controls}>
        {/* A default opens read-only, so it is a view, not an edit (A-SCR-15). */}
        <Button href={`/screener/filters?id=${filter.id}`}>{filter.read_only ? "View rule" : "Edit"}</Button>
        {filter.read_only ? (
          <>
            <Button variant="primary" loading={pending === "save"} disabled={pending !== null} onClick={saveCopy}>
              {pending === "save" ? "Saving…" : "Save as my filter"}
            </Button>
            {failed === "save" && (
              <span role="alert" className={styles.error}>
                {"Couldn't save the copy · "}
                <button type="button" className={styles.link} onClick={saveCopy}>Try again</button>
              </span>
            )}
          </>
        ) : confirming ? (
          <>
            <InlineConfirm
              label="Confirm deleting this filter"
              prompt="Delete this filter?"
              tone="danger"
              confirmLabel={pending === "delete" ? "Deleting…" : "Delete"}
              cancelLabel="Keep"
              busy={pending === "delete"}
              returnFocus={deleteRef}
              onConfirm={remove}
              onCancel={() => setConfirming(false)}
            />
            {failed === "delete" && (
              <span role="alert" className={styles.error}>
                {"Couldn't delete this filter · "}
                <button type="button" className={styles.link} onClick={remove}>Try again</button>
              </span>
            )}
          </>
        ) : (
          <Button ref={deleteRef} onClick={() => setConfirming(true)}>Delete</Button>
        )}
        <a href={`/alerts/new?from=filter:${filter.id}`} className={styles.link}>Alert on this filter</a>
      </div>
    </header>
  );
}
