"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import type { PauseExit } from "@/lib/replay/playView";
import type { Paused } from "@/lib/replay/schemas";
import { pauseView } from "@/lib/replay/swing";
import styles from "./play.module.css";

export type StopPausedToastProps = {
  paused: Paused;
  /** What Exit does (an exit mark on the paused name); null when its side is not known, and Exit is left off. */
  exit: PauseExit | null;
  /** A request is under way (the exit, or the switch to the paused name). */
  busy: boolean;
  onExit: () => void;
  onKeep: () => void;
};

/**
 * Play stopped because an open hold's stop was crossed (02p b5): "NVDA crossed your stop 182.50 at 11:42 · Exit or keep".
 * Exit places a normal exit mark at the revealed price; Keep only dismisses. The toast stays until she answers or presses
 * play, and nothing is requested while it shows. Focus goes back to where it was when she answers.
 */
export function StopPausedToast({ paused, exit, busy, onExit, onKeep }: StopPausedToastProps) {
  const view = pauseView(paused);
  const returnTo = useRef<Element | null>(null);
  useEffect(() => {
    returnTo.current = document.activeElement;
  }, []);
  const answer = (action: () => void) => () => {
    action();
    const target = returnTo.current;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  };
  return (
    <div className={styles.pause} role="alert">
      <span>{view.text}</span>
      <span className={styles.pauseActions}>
        {exit && (
          <Button size="md" variant="primary" disabled={busy} onClick={answer(onExit)}>
            {practiceText("swingPauseExit", { symbol: exit.symbol })}
          </Button>
        )}
        <Button size="md" onClick={answer(onKeep)}>{PRACTICE_COPY.swingPauseKeep}</Button>
      </span>
    </div>
  );
}
