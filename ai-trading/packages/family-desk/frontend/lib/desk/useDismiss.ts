"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Light dismiss for a popover or menu: a press outside `ref`, or Escape, closes it. `via` says which, so Escape can hand
 * focus back to the button that opened it (a press outside leaves focus where the press put it).
 */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, onDismiss: (via: "pointer" | "escape") => void): void {
  const latest = useRef(onDismiss);
  useEffect(() => {
    latest.current = onDismiss;
  });
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) latest.current("pointer");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current("escape");
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref]);
}
