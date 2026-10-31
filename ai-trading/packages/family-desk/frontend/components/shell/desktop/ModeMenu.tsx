"use client";
// Plain links: full document navigation lets the strategy builder's beforeunload guard run.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { moveActive } from "@/lib/desk/listNav";
import { LANE_HOME, LANE_LABEL, LANE_SUMMARY, LANES, type Lane } from "@/lib/lanes";
import { isTextField } from "@/lib/replay/keys";
import { useDeskUi } from "./DeskContext";
import styles from "./topbar.module.css";

const SHORTCUT: Record<string, Lane> = { Digit1: "technical", Digit2: "fundamental", Digit3: "backtest" };

/** The mode switcher (ADR-0014, design-modes-cutover §3.5): the mode's full word opens a three-item menu; Alt+1/2/3 jump.
 * A switch is a navigation to the mode's home: the route then decides the mode, so nothing in the shell keeps stale state. */
export function ModeMenu() {
  const { lane, confirmLeave } = useDeskUi();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = SHORTCUT[event.code];
      if (!target || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (isTextField(document.activeElement as HTMLElement | null)) return;
      event.preventDefault();
      if (confirmLeave()) window.location.assign(LANE_HOME[target]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmLeave]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[LANES.indexOf(lane)]?.focus();
    const onPointer = (event: MouseEvent) => {
      if (event.target instanceof Node && !wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, lane]);

  function onButtonKey(event: ReactKeyboardEvent) {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    setOpen(true);
  }

  function onMenuKey(event: ReactKeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const current = itemRefs.current.findIndex((item) => item === document.activeElement);
    itemRefs.current[moveActive(current, event.key, LANES.length)]?.focus();
  }

  return (
    <div className={styles.anchor} ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.modeButton}
        aria-label={`Mode: ${LANE_LABEL[lane]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={onButtonKey}
      >
        {LANE_LABEL[lane]}
        <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label="Mode" className={`${styles.popover} ${styles.modeMenu}`} onKeyDown={onMenuKey}>
          {LANES.map((mode, index) => (
            <a
              key={mode}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              role="menuitemradio"
              aria-checked={mode === lane}
              aria-keyshortcuts={`Alt+${index + 1}`}
              className={styles.modeItem}
              href={LANE_HOME[mode]}
              onClick={(event) => {
                if (!confirmLeave()) event.preventDefault();
              }}
            >
              <span className={styles.modeName}>{LANE_LABEL[mode]}</span>
              <span className={styles.modeKey}>Alt {index + 1}</span>
              <span className={styles.modeSummary}>{LANE_SUMMARY[mode]}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
