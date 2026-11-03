"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, FieldError, FieldRow, Input } from "@/components/ui/Field";
import { formatEtDateClock } from "@/lib/desk/format";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { etDayOf } from "@/lib/replay/time";
import { checkJump, type ThreadClock } from "@/lib/replay/threadClock";
import hub from "./hub.module.css";
import o from "./overview.module.css";

/**
 * Jump (ADR-0025): the date and time to move the thread clock to, typed in New York time, the zone every time here is read in. Forward only
 * and no later than the horizon, the latest time the data reaches: a time that is not ahead of the clock, or past the horizon, says why and
 * cannot be sent (the server refuses both too). Nothing is closed or ended by the move: open positions and working orders stay, resting
 * orders fill if the price crossed them on the way, and every position is priced at the new time. The boxes are plain native date and time
 * inputs; `noValidate` leaves the wording to this form rather than the browser's own bubble.
 */
export function ThreadJump({ clock, shown, busy, onJump }: { clock: ThreadClock; shown: string | null; busy: boolean; onJump: (to: string) => Promise<boolean> }) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [jumping, setJumping] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const check = checkJump(clock, shown, date, time);
  const horizon = formatEtDateClock(clock.horizon, { seconds: false });
  const from = shown ?? clock.clock;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (check.to === null || busy || jumping) return;
    const to = check.to;
    setJumping(true);
    setNote(PRACTICE_COPY.clockJumpingNote);
    const ok = await onJump(to);
    setJumping(false);
    setNote(ok ? practiceText("clockJumped", { when: formatEtDateClock(to, { seconds: false }) }) : null);
    if (ok) {
      setDate("");
      setTime("");
    }
  }

  return (
    <form role="group" aria-label={PRACTICE_COPY.clockJump} className={o.clockJump} noValidate onSubmit={(event) => void submit(event)} data-testid="thread-clock-jump">
      <FieldRow>
        <Field id="thread-jump-date" label={PRACTICE_COPY.clockJumpDate}>
          <Input type="date" value={date} min={from === null ? undefined : etDayOf(from)} max={etDayOf(clock.horizon)} disabled={busy} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Field id="thread-jump-time" label={PRACTICE_COPY.clockJumpTime}>
          <Input type="time" value={time} disabled={busy} onChange={(event) => setTime(event.target.value)} />
        </Field>
        <Button type="submit" className={o.clockJumpGo} loading={jumping} disabled={check.to === null || busy}>
          {jumping ? PRACTICE_COPY.clockJumping : PRACTICE_COPY.clockJumpGo}
        </Button>
      </FieldRow>
      {check.problem && <FieldError>{check.problem}</FieldError>}
      <p className={hub.hint}>{practiceText("clockJumpHint", { horizon })}</p>
      {note && <p className={hub.hint} role="status">{note}</p>}
    </form>
  );
}
