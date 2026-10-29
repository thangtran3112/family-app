"use client";

import { useHoldings } from "@/components/shell/desktop/DeskContext";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { AsOfLine } from "@/components/ui/AsOfLine";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadResearch, loadValuation } from "@/lib/desk/research";
import { isBadSymbolError, STOCK_VIEWS, stockHref, type StockView } from "@/lib/desk/researchView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "../fundamental.module.css";
import local from "./stocks.module.css";
import { StockOverview } from "./StockOverview";
import { StockTimeline } from "./StockTimeline";
import { StockValuation } from "./StockValuation";

/** One stock (02n FD8 to FD10): the header, the three tabs and the open tab. Research and valuation load here once and the tabs share them. */
export function StockPage({ symbol, view }: { symbol: string; view: StockView }) {
  const research = useDeskQuery(`research:${symbol}`, (signal) => loadResearch(symbol, { signal }), { intervalMs: 5 * 60_000 });
  // The overview only needs the price (for the verdict's range bar) once there is a verdict; the valuation tab always needs it.
  const wantsValuation = view === "valuation" || research.data?.verdict != null;
  const valuation = useDeskQuery(`valuation:${symbol}`, (signal) => loadValuation(symbol, { signal }), { enabled: wantsValuation });
  const { holdings } = useHoldings();
  const name = holdings?.rows.find((row) => row.symbol === symbol)?.name ?? null;
  const data = research.data;
  const bad = isBadSymbolError(research.error) || isBadSymbolError(valuation.error);

  return (
    <>
      <header className={local.stockHead}>
        <h1 className={styles.pageTitle} style={{ margin: 0 }}>{symbol}</h1>
        {name && <span className={local.stockName}>{name}</span>}
        <span style={{ marginLeft: "auto" }} />
        {data && <FreshnessBadge stamp={data.stamp} />}
      </header>
      {data && <AsOfLine stamp={data.stamp} />}
      <nav className={styles.tabs} aria-label="Stock views">
        {STOCK_VIEWS.map((item) => (
          <a key={item.id} className={styles.tab} href={stockHref(symbol, item.id)} aria-current={item.id === view ? "page" : undefined} data-testid={`fund-stock-tab-${item.id}`}>
            {item.label}
          </a>
        ))}
      </nav>
      {bad ? (
        <p className={styles.banner} role="status">That doesn&apos;t look like a ticker · try a symbol such as AAPL</p>
      ) : view === "overview" ? (
        data ? (
          <StockOverview symbol={symbol} research={data} price={valuation.data?.price ?? null} />
        ) : research.error !== null ? (
          <ErrorBlock subject="stock page" onRetry={research.refresh} />
        ) : (
          <LoadingBlock label="Loading the overview…" height={240} />
        )
      ) : view === "valuation" ? (
        valuation.data ? (
          <StockValuation valuation={valuation.data} />
        ) : valuation.error !== null ? (
          <ErrorBlock subject="valuation" onRetry={valuation.refresh} />
        ) : (
          <LoadingBlock label="Loading the valuation…" height={240} />
        )
      ) : (
        <StockTimeline symbol={symbol} />
      )}
    </>
  );
}
