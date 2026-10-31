"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useDismiss } from "@/lib/desk/useDismiss";
import styles from "./Popover.module.css";

/** What the trigger button must spread: the anchor reads `ref` to hand focus back on Escape. */
export type PopoverTriggerProps = {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "menu" | "dialog";
  "aria-expanded": boolean;
  onClick: () => void;
};

type PopoverProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** The panel's role, and the trigger's `aria-haspopup`. */
  role: "menu" | "dialog";
  /** The panel's accessible name. */
  label: string;
  /** Which edge of the trigger the panel lines up with. */
  align?: "start" | "end";
  /** Panel width in px (layout only). */
  width: number;
  /** Runs once each time the panel opens, with the panel element (Menu puts focus on an item here). Keep it stable. */
  onOpen?: (panel: HTMLDivElement) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
};

/**
 * One trigger button and the panel it opens, on `useDismiss`: a press outside closes it, and Escape closes it and returns
 * focus to the trigger. No portal: the panel is absolutely positioned under the anchor, so it needs a positioned ancestor
 * only through this wrapper. Controlled: the caller owns `open`.
 */
export function Popover({ open, onOpenChange, trigger, role, label, align = "end", width, onOpen, onKeyDown, children }: PopoverProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useDismiss(open, anchorRef, (via) => {
    onOpenChange(false);
    if (via === "escape") triggerRef.current?.focus();
  });

  useEffect(() => {
    if (open && panelRef.current) onOpen?.(panelRef.current);
  }, [open, onOpen]);

  return (
    <div className={styles.anchor} ref={anchorRef}>
      {trigger({ ref: triggerRef, "aria-haspopup": role, "aria-expanded": open, onClick: () => onOpenChange(!open) })}
      {open && (
        <div ref={panelRef} role={role} aria-label={label} className={styles.panel} data-align={align} style={{ width }} onKeyDown={onKeyDown}>
          {children}
        </div>
      )}
    </div>
  );
}
