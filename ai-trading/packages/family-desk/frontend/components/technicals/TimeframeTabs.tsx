"use client";

import { useRef, type KeyboardEvent } from "react";
import type { TimeframeOption } from "@/lib/desk/timeframes";
import styles from "./summary.module.css";

export function TimeframeTabs({
  options,
  value,
  onChange,
  label = "Timeframe",
}: {
  options: readonly TimeframeOption[];
  value: string;
  onChange: (api: string) => void;
  label?: string;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = Math.max(0, options.findIndex((option) => option.api === value));

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = options.length;
    const moves: Record<string, number> = { ArrowRight: (index + 1) % count, ArrowLeft: (index + count - 1) % count, Home: 0, End: count - 1 };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    tabs.current[next]?.focus();
    const option = options[next];
    if (option) onChange(option.api);
  }

  return (
    <div role="tablist" aria-label={label} className={styles.tabs}>
      {options.map((option, index) => (
        <button
          key={option.api}
          ref={(element) => { tabs.current[index] = element; }}
          type="button"
          role="tab"
          aria-selected={option.api === value}
          tabIndex={index === active ? 0 : -1}
          className={styles.tab}
          onClick={() => onChange(option.api)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
