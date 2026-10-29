"use client";

import { FundamentalRightRail } from "@/components/fundamental/rail/FundamentalRightRail";
import { ImportLine } from "@/components/fundamental/shared/ImportLine";
import { useDeskUi, useHoldings } from "@/components/shell/desktop/DeskContext";
import { useHash } from "@/lib/desk/useHash";
import styles from "../fundamental.module.css";
import local from "./coveredCalls.module.css";
import { IncomeView } from "./IncomeView";
import { ScanView } from "./ScanView";

/** FD4 Scan (`#scan`, the default) and FD5 Open calls & income (`#income`) on one route (02n §b3). The numbers are the engine's; nothing here recomputes them. */
export function CoveredCallsScreen() {
  const view = useHash() === "income" ? "income" : "scan";
  const { holdings } = useHoldings();
  const { selectedSymbol } = useDeskUi();
  const accounts = holdings?.accounts ?? [];

  return (
    <div className={styles.screen} data-testid="fund-cc">
      <header className={styles.head}>
        <h1 className={styles.pageTitle}>Covered calls</h1>
        {holdings && <ImportLine state={holdings.import} />}
      </header>
      <nav className={styles.tabs} aria-label="Covered-call views">
        <a className={local.tabLink} href="#scan" aria-current={view === "scan" ? "page" : undefined} data-testid="fund-cc-tab-scan">Scan</a>
        <a className={local.tabLink} href="#income" aria-current={view === "income" ? "page" : undefined} data-testid="fund-cc-tab-income">Open calls &amp; income</a>
      </nav>
      {view === "scan" ? <ScanView accounts={accounts} importState={holdings?.import ?? null} /> : <IncomeView accounts={accounts} />}
      <FundamentalRightRail symbol={selectedSymbol} />
    </div>
  );
}
