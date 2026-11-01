"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { formatEtTimeZone } from "@/lib/desk/format";
import { etHhMm } from "@/lib/replay/time";
import styles from "./replay.module.css";

export type JumpMenuProps = {
  revealedThrough: string;
  windowEnd: string;
  disabled: boolean;
  onJumpBy: (minutes: number) => void;
  onJumpToTime: (hhmm: string) => void;
  onNextSignal: () => void;
  onJumpEnd: () => void;
  /** A swing session (02p d2) adds "+1 hour" and names the window end "the close". */
  swing?: boolean;
};

/** Focus lands on the first button when the panel opens. Module level, so the popover's open effect runs once per opening. */
const focusFirst = (panel: HTMLElement) => panel.querySelector<HTMLElement>("button")?.focus();

/**
 * Jump forward: +5 min, +15 min, (+1 hour for a swing session), to a time, to the next signal, to the window end. Never backward (02o decision 1).
 * A disclosure panel (`ui/Popover`, role "dialog") of plain buttons and one small form: a `menu` may not hold a form. Focus enters the
 * panel on the first button, Tab walks it, Escape or a choice closes it and focus returns to the Jump button.
 */
export function JumpMenu({ revealedThrough, windowEnd, disabled, onJumpBy, onJumpToTime, onNextSignal, onJumpEnd, swing = false }: JumpMenuProps) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const min = etHhMm(revealedThrough);
  const max = etHhMm(windowEnd);

  const choose = (action: () => void) => {
    action();
    setOpen(false);
    root.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
  };

  return (
    <div className={styles.jump} ref={root}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        role="dialog"
        label="Jump forward"
        align="start"
        width={288}
        onOpen={focusFirst}
        trigger={(props) => (
          <Button {...props} size="touch" disabled={disabled}>
            Jump <span aria-hidden="true">▾</span>
          </Button>
        )}
      >
        <div className={styles.menu}>
          <button type="button" className={styles.menuItem} onClick={() => choose(() => onJumpBy(5))}>+5 min</button>
          <button type="button" className={styles.menuItem} onClick={() => choose(() => onJumpBy(15))}>+15 min</button>
          {swing && <button type="button" className={styles.menuItem} onClick={() => choose(() => onJumpBy(60))}>+1 hour</button>}
          <form
            className={styles.menuRow}
            onSubmit={(event) => {
              event.preventDefault();
              if (time) choose(() => onJumpToTime(time));
            }}
          >
            <label className={styles.menuLabel}>
              To a time (ET)
              <input type="time" className={styles.control} value={time} min={min} max={max} onChange={(event) => setTime(event.target.value)} />
            </label>
            <Button type="submit" size="md" disabled={!time || time <= min}>Go</Button>
          </form>
          <button type="button" className={styles.menuItem} aria-keyshortcuts="Shift+ArrowRight" onClick={() => choose(onNextSignal)}>
            To the next signal
            <span className={styles.menuKeys} aria-hidden="true">Shift →</span>
          </button>
          <p className={styles.menuNote}>{PRACTICE_COPY.jumpSignalNote}</p>
          <button type="button" className={styles.menuItem} onClick={() => choose(onJumpEnd)}>
            {swing ? `To the close · ${formatEtTimeZone(windowEnd)}` : `To the window end · ${formatEtTimeZone(windowEnd)}`}
          </button>
        </div>
      </Popover>
    </div>
  );
}
