"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { FundamentalRightRail } from "@/components/fundamental/rail/FundamentalRightRail";
import { useDeskUi, useHoldings } from "@/components/shell/desktop/DeskContext";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { parseSymbolParam, stockHref, stockViewFromHash } from "@/lib/desk/researchView";
import { useHash } from "@/lib/desk/useHash";
import styles from "../fundamental.module.css";
import local from "./stocks.module.css";
import { StockPage } from "./StockPage";
import { StocksBrief } from "./StocksBrief";

/**
 * Research (02n FD7 to FD10). `/stocks` is the AI daily brief; `/stocks?symbol=AAPL#overview|valuation|timeline` is one
 * stock. The symbol and the tab live in the address, so a link or a reload lands on the same view.
 */
export function StocksScreen() {
  const params = useSearchParams();
  const hash = useHash();
  const raw = params.get("symbol");
  const symbol = parseSymbolParam(raw);
  const { setSelectedSymbol } = useDeskUi();

  useEffect(() => {
    if (symbol) setSelectedSymbol(symbol);
  }, [symbol, setSelectedSymbol]);

  return (
    <div className={styles.screen} data-testid="fund-stocks">
      <div className={local.toolbar}>
        <SymbolForm />
        <HoldingPicks current={symbol} />
      </div>
      {raw !== null && symbol === null ? (
        <Banner>That doesn&apos;t look like a ticker · try a symbol such as AAPL</Banner>
      ) : symbol ? (
        <StockPage key={symbol} symbol={symbol} view={stockViewFromHash(hash)} />
      ) : (
        <StocksBrief />
      )}
      <FundamentalRightRail symbol={symbol} />
    </div>
  );
}

/** A plain GET form: Enter opens `/stocks?symbol=…` as a full navigation, like the rest of the shell, with no script needed. */
function SymbolForm() {
  return (
    <form className={local.symbolForm} method="get" action="/stocks" role="search" aria-label="Open a stock">
      <label className={styles.caption} htmlFor="fund-stock-symbol">Symbol</label>
      <input id="fund-stock-symbol" className={local.symbolInput} name="symbol" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={15} placeholder="AAPL" />
      <Button type="submit" size="md">Open</Button>
    </form>
  );
}

function HoldingPicks({ current }: { current: string | null }) {
  const { holdings } = useHoldings();
  const rows = holdings?.rows ?? [];
  if (rows.length === 0) return null;
  return (
    <nav className={local.picks} aria-label="Your holdings">
      <span className={styles.caption}>Your holdings</span>
      {rows.map((row) => (
        <Button key={row.symbol} href={stockHref(row.symbol)} size="sm" aria-current={row.symbol === current ? "page" : undefined}>{row.symbol}</Button>
      ))}
    </nav>
  );
}
