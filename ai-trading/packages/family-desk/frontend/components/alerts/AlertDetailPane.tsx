"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { deleteAlertStrategy, loadAlertFires, loadAlertStrategy } from "@/lib/desk/alerts";
import { actionError, actionFor, actionLabel, deliveryTone, sourceText, statusText, statusTone } from "@/lib/desk/alertsView";
import { formatEtStamp } from "@/lib/desk/format";
import { channelLabel, deliveryLabel } from "@/lib/desk/labels";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { describeSpec } from "@/lib/spec/describe";
import { parseAlertSpec } from "@/lib/spec/parse";
import { runRowAction } from "./AlertTable";
import { FireThumb } from "./FireThumb";
import styles from "./alerts.module.css";
import { alertNewHref } from "@/lib/desk/hrefs";

/** Right pane of D9: the selected alert strategy, its sentence, JSON and recent fires. */
export function AlertDetailPane({ id, onChanged }: { id: number | null; onChanged: () => void }) {
  if (id === null) return <p className={styles.muted}>Select an alert strategy to see its details</p>;
  return <AlertDetail key={id} id={id} onChanged={onChanged} />;
}

function AlertDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const detail = useDeskQuery(`alert-detail:${id}`, (signal) => loadAlertStrategy(id, { signal }));
  const fires = useDeskQuery(`alert-fires:${id}`, (signal) => loadAlertFires(id, 10, { signal }));
  const [busy, setBusy] = useState<"action" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const [deleted, setDeleted] = useState(false);

  if (deleted) return <p className={styles.muted}>This alert strategy was deleted. Select another to see its details.</p>;
  if (detail.data === null) {
    return detail.error === null
      ? <LoadingBlock label="Loading alert…" height={120} />
      : <ErrorBlock subject="alert" onRetry={detail.refresh} />;
  }

  const strategy = detail.data;
  const action = actionFor(strategy);
  const parsed = parseAlertSpec(strategy.spec);

  async function runAction() {
    if (!action) return;
    setBusy("action");
    setError(null);
    try {
      await runRowAction(action, id);
      detail.refresh();
      onChanged();
    } catch (cause) {
      setError(actionError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    setError(null);
    try {
      await deleteAlertStrategy(id);
      setDeleted(true);
      onChanged();
    } catch (cause) {
      setError(actionError(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.pane}>
      <h2 className={styles.paneTitle}>{strategy.name}</h2>
      <div className={styles.meta}>
        <Badge tone={statusTone(strategy.status)}>{statusText(strategy)}</Badge>
        <span className={styles.muted}>{sourceText(strategy.source)}</span>
      </div>
      {parsed && <p className={styles.sentence}>{describeSpec(parsed)}</p>}

      <div className={styles.actions}>
        {action && (
          <Button disabled={busy !== null} loading={busy === "action"} onClick={runAction}>
            {busy === "action" ? "Working…" : actionLabel(action)}
          </Button>
        )}
        <Link href={alertNewHref({ edit: id })} className={styles.link}>Edit</Link>
        {confirming ? (
          <InlineConfirm
            label="Confirm deleting this alert strategy"
            prompt="Delete this alert strategy?"
            tone="danger"
            confirmLabel={busy === "delete" ? "Deleting…" : "Delete"}
            cancelLabel="Keep"
            busy={busy === "delete"}
            returnFocus={deleteRef}
            onConfirm={remove}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <Button ref={deleteRef} variant="danger" onClick={() => setConfirming(true)}>Delete</Button>
        )}
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}

      <h3 className={styles.heading}>Recent fires</h3>
      {fires.data === null ? (
        fires.error === null
          ? <LoadingBlock label="Loading fires…" height={60} />
          : <ErrorBlock message="Couldn't load recent fires · Try again" onRetry={fires.refresh} />
      ) : fires.data.length === 0 ? (
        <p className={styles.muted}>Hasn&apos;t fired yet</p>
      ) : (
        <ul className={styles.fires}>
          {fires.data.map((fire) => (
            <li key={fire.signal_id} className={styles.fire}>
              <FireThumb bars={fire.thumb.bars} />
              <div className={styles.fireText}>
                <span className={styles.name}>{fire.symbol}</span>
                <span className={styles.muted}>{formatEtStamp(fire.bar_time)}</span>
                <span className={styles.meta}>
                  {fire.deliveries.map((delivery) => (
                    <Badge key={delivery.channel} tone={deliveryTone(delivery.status)} wrap>
                      {channelLabel(delivery.channel)} · {deliveryLabel(delivery.status)}
                    </Badge>
                  ))}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <details className={styles.details}>
        <summary>Developer view (JSON)</summary>
        <pre className={styles.json}>{JSON.stringify(strategy.spec, null, 2)}</pre>
      </details>
    </div>
  );
}
