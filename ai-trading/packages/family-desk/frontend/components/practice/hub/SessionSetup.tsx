"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { createReplaySession } from "@/lib/desk/replay";
import {
  EARLIEST_DAY,
  INTERVALS,
  fieldProblems,
  latestReplayDay,
  validateDraft,
  withSession,
  withTypedDay,
  type FieldProblems,
  type SetupDraft,
} from "@/lib/replay/setup";
import { ArmStrategiesField } from "./ArmStrategiesField";
import { SymbolField } from "./SymbolField";
import styles from "./hub.module.css";

const SESSIONS = [
  { value: "regular", label: "Regular" },
  { value: "extended", label: "Extended" },
] as const;

/** The setup form (02o §a2). Live checks run on submit; a 422 from the server lands on the field it names. */
export function SessionSetup({ draft, onDraft }: { draft: SetupDraft; onDraft: (draft: SetupDraft) => void }) {
  const router = useRouter();
  const [problems, setProblems] = useState<FieldProblems>({});
  const [submitting, setSubmitting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);

  async function start() {
    const result = validateDraft(draft, new Date());
    if (!result.ok) {
      setProblems(result.problems);
      return;
    }
    setProblems({});
    setStartFailed(false);
    setSubmitting(true);
    try {
      const session = await createReplaySession(result.spec);
      router.push(`/practice/replay?id=${session.id}`);
    } catch (error) {
      if (error instanceof DeskApiError && error.status === 422 && error.problems.length > 0) setProblems(fieldProblems(error.problems));
      else setStartFailed(true);
      setSubmitting(false);
    }
  }

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <div className={styles.row}>
        <SymbolField value={draft.symbol} onChange={(symbol) => onDraft({ ...draft, symbol })} error={problems.symbol} />
        <DayField draft={draft} onDraft={onDraft} error={problems.day} />
      </div>

      <fieldset className={styles.group} aria-describedby={problems.window ? "window-error" : undefined}>
        <legend className={styles.legend}>Window (ET)</legend>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>From</span>
            <input type="time" className={styles.control} value={draft.from} onChange={(event) => onDraft({ ...draft, from: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>To</span>
            <input type="time" className={styles.control} value={draft.to} onChange={(event) => onDraft({ ...draft, to: event.target.value })} />
          </label>
          <div role="group" aria-label="Session" className={styles.segmented}>
            {SESSIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={styles.segment}
                aria-pressed={draft.session === item.value}
                onClick={() => onDraft(withSession(draft, item.value))}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {problems.window && <p id="window-error" role="alert" className={styles.fieldError}>{problems.window}</p>}
      </fieldset>

      <div className={styles.field}>
        <span id="interval-label" className={styles.label}>Chart interval</span>
        <div role="group" aria-labelledby="interval-label" className={styles.segmented}>
          {INTERVALS.map((interval) => (
            <button
              key={interval}
              type="button"
              className={styles.segment}
              aria-pressed={draft.interval === interval}
              onClick={() => onDraft({ ...draft, interval })}
            >
              {interval}
            </button>
          ))}
        </div>
        {problems.interval && <p role="alert" className={styles.fieldError}>{problems.interval}</p>}
      </div>

      <ArmStrategiesField armed={draft.armed} onChange={(armed) => onDraft({ ...draft, armed })} error={problems.armed} />

      {problems.form && <p role="alert" className={styles.fieldError}>{problems.form}</p>}
      {startFailed && <ErrorBlock message={PRACTICE_COPY.startError} onRetry={() => void start()} />}
      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={submitting}>Start practice</button>
      </div>
    </form>
  );
}

/** A picked notable day while dates are hidden shows no date text: a chip and a way to type another day. */
function DayField({ draft, onDraft, error }: { draft: SetupDraft; onDraft: (draft: SetupDraft) => void; error?: string }) {
  return (
    <div role="group" aria-labelledby="day-label" className={styles.field}>
      <span id="day-label" className={styles.label}>Day</span>
      {draft.dayHidden ? (
        <div className={styles.inline}>
          <span className={styles.chip}>{PRACTICE_COPY.hiddenDay}</span>
          <button type="button" className={styles.button} onClick={() => onDraft(withTypedDay(draft, ""))}>Choose another day</button>
        </div>
      ) : (
        <input
          type="date"
          aria-labelledby="day-label"
          className={styles.control}
          value={draft.day}
          min={EARLIEST_DAY}
          max={latestReplayDay(new Date())}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "day-error" : undefined}
          onChange={(event) => onDraft(withTypedDay(draft, event.target.value))}
        />
      )}
      <button type="button" className={styles.linkButton} onClick={() => document.getElementById("notable-days")?.scrollIntoView()}>
        Pick from notable days
      </button>
      {error && <p id="day-error" role="alert" className={styles.fieldError}>{error}</p>}
    </div>
  );
}
