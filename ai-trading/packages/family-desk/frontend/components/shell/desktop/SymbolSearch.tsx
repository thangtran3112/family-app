"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { isSearchShortcut, moveActive, symbolHref } from "@/lib/desk/listNav";
import { searchSymbols } from "@/lib/desk/status";
import styles from "./topbar.module.css";

type Hit = Awaited<ReturnType<typeof searchSymbols>>[number];
/** The answer for query `q`; `hits` is null when the request failed. */
type Answer = { q: string; hits: Hit[] | null };

export function SymbolSearch({ compact }: { compact: boolean }) {
  const router = useRouter();
  const { confirmLeave } = useDeskUi();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef(0);
  const latest = useRef("");
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      setExpanded(true);
      inputRef.current?.focus();
    }
    document.addEventListener("keydown", onShortcut);
    return () => document.removeEventListener("keydown", onShortcut);
  }, []);

  const query = text.trim();
  // Only an answer for the text on screen counts; an older one that lands late is dropped in runSearch.
  const current = answer?.q === text ? answer : null;
  const failed = current !== null && current.hits === null;
  const hits = current?.hits ?? [];
  const listOpen = open && hits.length > 0;
  const showNote = open && query !== "" && current !== null && hits.length === 0;

  function runSearch(q: string) {
    searchSymbols(q, 8).then(
      (found) => {
        if (latest.current === q) setAnswer({ q, hits: found });
      },
      () => {
        if (latest.current === q) setAnswer({ q, hits: null });
      },
    );
  }

  function changeText(next: string) {
    latest.current = next;
    window.clearTimeout(timer.current);
    setText(next);
    setActive(-1);
    setOpen(true);
    if (next.trim()) timer.current = window.setTimeout(() => runSearch(next), 200);
  }

  function choose(symbol: string) {
    if (!confirmLeave()) return;
    latest.current = "";
    window.clearTimeout(timer.current);
    setText("");
    setActive(-1);
    setOpen(false);
    setExpanded(false);
    router.push(symbolHref(symbol));
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive(moveActive(active, event.key, hits.length));
    } else if (event.key === "Enter" && hits[active]) {
      event.preventDefault();
      choose(hits[active].symbol);
    } else if (event.key === "Enter" && /^\/?[A-Za-z][A-Za-z0-9.]{0,9}$/.test(text.trim())) {
      // No row highlighted: a typed ticker still opens its chart.
      event.preventDefault();
      choose(text.trim().toUpperCase());
    } else if (event.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  if (compact && !expanded) {
    return (
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Search symbols, ⌘K"
        title="Search symbols (⌘K)"
        onClick={() => setExpanded(true)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    );
  }

  return (
    <div className={styles.anchor}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        className={styles.searchInput}
        aria-label="Search symbols"
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-activedescendant={listOpen && active >= 0 ? optionId(active) : undefined}
        placeholder="Search symbols"
        title="Search symbols (⌘K)"
        autoComplete="off"
        spellCheck={false}
        autoFocus={compact}
        value={text}
        onChange={(event: ChangeEvent<HTMLInputElement>) => changeText(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          if (!text) setExpanded(false);
        }}
      />
      <kbd className={styles.kbd} aria-hidden="true">⌘K</kbd>
      {listOpen && (
        <ul id={listId} role="listbox" aria-label="Matching symbols" className={`${styles.popover} ${styles.results}`}>
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
              <span className={styles.tag}>{hit.asset_type === "etf" ? "ETF" : "stock"}</span>
              {hit.in_watchlist && <span className={styles.watched}>In a watchlist</span>}
            </li>
          ))}
        </ul>
      )}
      {showNote && (
        <div className={`${styles.popover} ${styles.note}`} role="status">
          {failed ? (
            <>
              Search is unavailable right now ·{" "}
              <button
                type="button"
                className={styles.textButton}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runSearch(text)}
              >
                try again
              </button>
            </>
          ) : (
            <>No symbols match “{query}”</>
          )}
        </div>
      )}
    </div>
  );
}
