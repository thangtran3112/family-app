"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { moveActive } from "@/lib/desk/listNav";
import { searchSymbols } from "@/lib/desk/status";
import styles from "./hub.module.css";

type Hit = Awaited<ReturnType<typeof searchSymbols>>[number];
/** The answer for query `q`; `hits` is null when the search failed. */
type Answer = { q: string; hits: Hit[] | null };

/** Symbol input with a suggestion list (combobox pattern, as the top-bar search). Text is uppercased as typed. */
export function SymbolField({ value, onChange, error }: { value: string; onChange: (symbol: string) => void; error?: string }) {
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const errorId = `${baseId}-error`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const query = value.trim();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (query === "") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchSymbols(query, 8, { signal: controller.signal }).then(
        (hits) => { if (!controller.signal.aborted) setAnswer({ q: query, hits }); },
        () => { if (!controller.signal.aborted) setAnswer({ q: query, hits: null }); },
      );
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Only an answer for the text on screen counts; an older one is ignored.
  const current = answer?.q === query ? answer : null;
  const hits = current?.hits ?? [];
  const listOpen = open && query !== "" && hits.length > 0;
  const note = open && query !== "" && current !== null && hits.length === 0
    ? current.hits === null ? "Suggestions are unavailable right now" : `No symbols match “${query}”`
    : null;

  function choose(symbol: string) {
    onChange(symbol);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && listOpen) {
      event.preventDefault();
      setActive(moveActive(active, event.key, hits.length));
    } else if (event.key === "Enter" && listOpen && hits[active]) {
      event.preventDefault();
      choose(hits[active].symbol);
    } else if (event.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <div className={styles.field}>
      <label htmlFor={inputId} className={styles.label}>Symbol</label>
      <div className={styles.combo}>
        <input
          id={inputId}
          type="text"
          role="combobox"
          className={styles.control}
          placeholder="NVDA"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-autocomplete="list"
          aria-expanded={listOpen}
          aria-controls={listId}
          aria-activedescendant={listOpen && active >= 0 ? optionId(active) : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            onChange(event.target.value.toUpperCase());
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {listOpen && (
          <ul id={listId} role="listbox" aria-label="Matching symbols" className={styles.popover}>
            {hits.map((hit, index) => (
              <li
                key={hit.symbol}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                className={styles.option}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(hit.symbol)}
              >
                <span className={styles.optionSymbol}>{hit.symbol}</span>
                <span className={styles.optionName}>{hit.name}</span>
                <span className={styles.tag}>{hit.asset_type === "etf" ? "ETF" : "Stock"}</span>
              </li>
            ))}
          </ul>
        )}
        {note && <div className={`${styles.popover} ${styles.note}`} role="status">{note}</div>}
      </div>
      {error && <p id={errorId} role="alert" className={styles.fieldError}>{error}</p>}
    </div>
  );
}
