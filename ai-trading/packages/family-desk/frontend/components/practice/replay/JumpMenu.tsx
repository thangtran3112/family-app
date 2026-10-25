"use client";

import { useEffect, useId, useRef, useState } from "react";
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
};

/** Jump forward: +5 min, +15 min, to a time, to the next signal, to the window end. Never backward (02o decision 1). */
export function JumpMenu({ revealedThrough, windowEnd, disabled, onJumpBy, onJumpToTime, onNextSignal, onJumpEnd }: JumpMenuProps) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
      } else if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);

  const run = (action: () => void) => () => {
    action();
    setOpen(false);
  };
  const min = etHhMm(revealedThrough);
  const max = etHhMm(windowEnd);

  return (
    <div className={styles.jump} ref={root}>
      <button type="button" className={styles.button} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)}>
        Jump ▾
      </button>
      {open && (
        <div id={menuId} className={styles.menu} role="menu" aria-label="Jump forward">
          <button type="button" role="menuitem" className={styles.menuItem} onClick={run(() => onJumpBy(5))}>+5 min</button>
          <button type="button" role="menuitem" className={styles.menuItem} onClick={run(() => onJumpBy(15))}>+15 min</button>
          <form
            className={styles.menuRow}
            onSubmit={(event) => {
              event.preventDefault();
              if (time) run(() => onJumpToTime(time))();
            }}
          >
            <label className={styles.menuLabel}>
              To a time (ET)
              <input type="time" className={styles.control} value={time} min={min} max={max} onChange={(event) => setTime(event.target.value)} />
            </label>
            <button type="submit" className={styles.button} disabled={!time || time <= min}>Go</button>
          </form>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            title="Reveals through the next time one of your armed strategies would fire. A strategy-testing tool: it tells you a signal is coming."
            onClick={run(onNextSignal)}
          >
            To the next signal
          </button>
          <button type="button" role="menuitem" className={styles.menuItem} onClick={run(onJumpEnd)}>To the window end · {formatEtTimeZone(windowEnd)}</button>
        </div>
      )}
    </div>
  );
}
