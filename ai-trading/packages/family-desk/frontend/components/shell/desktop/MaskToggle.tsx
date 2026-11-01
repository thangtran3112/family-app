"use client";

import { useEffect } from "react";
import { Icon } from "@/components/ui/Icon";
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
      <Icon name={maskValues ? "eye-off" : "eye"} />
      <span>{label}</span>
    </button>
  );
}
