"use client";

import { useEffect, useState } from "react";
import type { MarketDataCard as Card, MarketDataClass } from "@/lib/api/schemas";
import { DeskApiError } from "@/lib/api/client";
import { classOf, COPY, optionsFor, ownerNote, previewText, rowNote, servingText } from "@/lib/desk/marketDataCopy";
import { loadMarketDataCard, saveMarketDataChoice } from "@/lib/desk/marketData";
import styles from "./MarketDataCard.module.css";

// Settings · Market data (02t §6; M boards XN2-2 at 1440 and XUL-2's states). One editable row (stock
// quotes, owner only) and two read-only rows. In shadow mode the card carries the Preview badge and says
// what the bridge would serve, without the Desk switching to it.

type Save = { status: "idle" | "saving"; error?: string; warning?: string };

type RowId = "quotes" | "options" | "bars";

function Row({
  row,
  title,
  note,
  card,
  source,
  editable,
  onChoose,
  saving,
  error,
  warning,
}: {
  row: RowId;
  title: string;
  note: string;
  card: Card;
  source: MarketDataClass | null;
  editable: boolean;
  onChoose?: (provider: string) => void;
  saving: boolean;
  error?: string;
  warning?: string;
}) {
  const options = optionsFor(row, source, source?.serving ?? "");
  const selected = source?.preferred ?? "";
  return (
    <div className={styles.row}>
      <div className={styles.rowHeader}>
        <h3 className={styles.rowTitle}>{title}</h3>
        <p className={styles.rowNote}>{note}</p>
      </div>
      <div
        className={styles.options}
        role={editable ? "radiogroup" : undefined}
        aria-label={editable ? title : undefined}
      >
        {options.map((option) => {
          const disabled = !editable || option.disabled;
          const isSelected = editable && selected === option.provider;
          return (
            <label
              key={option.provider}
              className={styles.option}
              data-selected={isSelected}
              // A read-only row still shows which provider answers it (M board: Alpaca "in use").
              data-in-use={!editable && row !== "quotes" && option.provider === (source?.serving ?? "")}
              data-disabled={!editable || option.disabled}
              aria-disabled={!editable || option.disabled}
            >
              {editable && (
                <input
                  className={styles.input}
                  type="radio"
                  name={`market-data-${row}`}
                  value={option.provider}
                  checked={isSelected}
                  disabled={disabled || saving}
                  onChange={() => onChoose?.(option.provider)}
                />
              )}
              <span className={styles.ring} aria-hidden="true" />
              <span className={styles.optionName}>{option.label}</span>
              <span className={styles.optionState}>{option.text}</span>
            </label>
          );
        })}
      </div>
      <p className={styles.serving}>
        <span className={styles.dot} aria-hidden="true" />
        {servingText(row, card, source)}
      </p>
      {error && (
        <p className={styles.rowError} role="alert">
          {error}
        </p>
      )}
      {warning && (
        <p className={styles.rowSaved} role="status">
          {warning}
        </p>
      )}
    </div>
  );
}

export function MarketDataCard() {
  const [card, setCard] = useState<Card | null>(null);
  const [failed, setFailed] = useState(false);
  const [save, setSave] = useState<Save>({ status: "idle" });

  useEffect(() => {
    let active = true;
    loadMarketDataCard()
      .then((value) => {
        if (active) setCard(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  async function choose(provider: string) {
    if (card === null || !card.owner) return;
    setSave({ status: "saving" });
    try {
      const result = await saveMarketDataChoice({ data_class: "equity_quotes", provider });
      setCard({ ...card, classes: result.classes, routing_source: result.routing_source, version: result.version });
      setSave({ status: "idle", warning: result.warning ?? undefined });
    } catch (error: unknown) {
      // A 422's `detail` is the reason in words (02t §3.5): shown inline under the row, unchanged.
      const detail = error instanceof DeskApiError ? error.detail : undefined;
      setSave({ status: "idle", error: detail ?? "That choice wasn't saved. Try again." });
    }
  }

  const quotes = card ? classOf(card, "equity_quotes") : null;
  const chains = card ? classOf(card, "option_chain") : null;
  const bars = card ? classOf(card, "equity_bars") : null;
  const editable = Boolean(card?.owner && card.available && quotes?.ladder.length);

  return (
    <section className={styles.card} aria-labelledby="settings-market-data">
      <header className={styles.title}>
        <h2 id="settings-market-data" className={styles.heading}>
          {COPY.title}
        </h2>
        <p className={styles.subtitle}>{COPY.subtitle}</p>
      </header>

      {card === null && <p className={styles.helper}>{failed ? COPY.loadFailed : COPY.loading}</p>}

      {card?.shadow && (
        <div className={styles.preview}>
          <span className={styles.badge}>{COPY.previewBadge}</span>
          <p className={styles.previewText}>{previewText(card)}</p>
        </div>
      )}

      {card && !card.available && <p className={styles.helper}>{COPY.bridgeOffLine}</p>}

      {card && (
        <>
          <Row
            row="quotes"
            title="Stock quotes"
            note={rowNote("quotes", quotes)}
            card={card}
            source={quotes}
            editable={editable}
            onChoose={(provider) => void choose(provider)}
            saving={save.status === "saving"}
            error={save.error}
            warning={save.warning}
          />
          <Row
            row="options"
            title="Option chains"
            note={rowNote("options", chains)}
            card={card}
            source={chains}
            editable={false}
            saving={false}
          />
          <Row
            row="bars"
            title="Bars"
            note={rowNote("bars", bars)}
            card={card}
            source={bars}
            editable={false}
            saving={false}
          />
        </>
      )}

      {card?.reason === "routing_syncing" && (
        <p className={styles.syncing}>
          <span className={styles.syncingRing} aria-hidden="true" />
          {COPY.syncing}
        </p>
      )}

      {card && <p className={styles.ownerNote}>{ownerNote(card.owner)}</p>}
    </section>
  );
}