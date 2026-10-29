"use client";

import { useEffect } from "react";
import { COPY } from "@/lib/desk/freshness";
import { useDeskUi } from "./DeskContext";
import styles from "./topbar.module.css";

/** `Show values | Hide values` (02n §b1, Alt+M): the Fundamental lane's one masking switch. It names the action, not the state. */
export function MaskToggle() {
  const { maskValues, setMaskValues } = useDeskUi();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === "KeyM") {
        event.preventDefault();
        setMaskValues(!maskValues);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [maskValues, setMaskValues]);

  const label = maskValues ? COPY.maskShow : COPY.maskHide;
  return (
    <button
      type="button"
      className={styles.maskToggle}
      aria-pressed={!maskValues}
      title={`${maskValues ? COPY.valuesHidden : label} (Alt+M)`}
      onClick={() => setMaskValues(!maskValues)}
      data-testid="mask-toggle"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
        {maskValues && <path d="m4 4 16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
      </svg>
      <span>{label}</span>
    </button>
  );
}
