"use client";

import type { ReactNode } from "react";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { LibraryEntry, LibraryItem } from "@/lib/api/schemas";
import { formatPrice } from "@/lib/desk/format";
import { categoryLabel } from "@/lib/desk/labels";
import { loadLibraryEntry } from "@/lib/desk/library";
import { defaultsLines, exampleCaption, plainEnglish, whenText } from "@/lib/desk/libraryView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { AttachButton } from "./AttachButton";
import { BiasChip } from "./PresetList";
import styles from "./library.module.css";

/** Right pane: the preset in plain words, its WHEN block, defaults and a real example, then Attach. */
export function PresetPreview({ item, listName, listId }: { item: LibraryItem; listName: string | null; listId: number | null }) {
  const entry = useDeskQuery(`library-entry:${item.id}`, (signal) => loadLibraryEntry(item.id, { signal }));
  const detail = entry.data;

  let body: ReactNode;
  if (detail) body = <Detail entry={detail} />;
  else if (entry.error === null) body = <LoadingBlock label="Loading preset…" height={240} />;
  else body = <ErrorBlock subject="preset" onRetry={entry.refresh} />;

  return (
    <article className={styles.preview}>
      <h2 className={styles.previewTitle}>{item.label}</h2>
      <p className={styles.previewMeta}>
        <BiasChip bias={item.bias} />
        <span>{categoryLabel(item.category)}</span>
      </p>
      <p className={styles.body}>{item.summary}</p>
      {body}
      <AttachButton key={listId ?? "none"} entry={detail ?? item} listId={listId} listName={listName} />
    </article>
  );
}

function Detail({ entry }: { entry: LibraryEntry }) {
  const english = plainEnglish(entry.spec);
  const when = whenText(entry.spec);
  const defaults = defaultsLines(entry.defaults);
  const example = entry.example;
  const caption = exampleCaption(entry.label, example);
  return (
    <>
      {english && (
        <section className={styles.section}>
          <h3 className={styles.heading}>In plain English</h3>
          <p className={styles.body}>{english}</p>
        </section>
      )}
      {when && (
        <section className={styles.section}>
          <h3 className={styles.heading}>When</h3>
          <p className={styles.whenBox}>{when}</p>
        </section>
      )}
      {defaults.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Defaults</h3>
          <ul className={styles.defaults}>
            {defaults.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </section>
      )}
      {example && caption && example.ohlc.length === 4 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Real example</h3>
          <Candle caption={caption} ohlc={example.ohlc} />
        </section>
      )}
    </>
  );
}

/** One real occurrence as a candle from [open, high, low, close]: green when it closed up, red otherwise. */
function Candle({ caption, ohlc }: { caption: string; ohlc: number[] }) {
  const [open, high, low, close] = ohlc;
  const span = high - low || 1;
  const y = (value: number) => 4 + ((high - value) / span) * 72;
  const top = y(Math.max(open, close));
  const bottom = y(Math.min(open, close));
  return (
    <figure className={styles.example}>
      <svg width="40" height="80" viewBox="0 0 40 80" aria-hidden="true" className={close >= open ? styles.candleUp : styles.candleDown}>
        <line x1="20" x2="20" y1={y(high)} y2={y(low)} strokeWidth="2" />
        <rect x="12" y={top} width="16" height={Math.max(bottom - top, 2)} />
      </svg>
      <figcaption className={styles.exampleText}>
        <span className={styles.caption}>{caption}</span>
        <span className={styles.ohlc}>
          Open {formatPrice(open)} · High {formatPrice(high)} · Low {formatPrice(low)} · Close {formatPrice(close)}
        </span>
      </figcaption>
    </figure>
  );
}
