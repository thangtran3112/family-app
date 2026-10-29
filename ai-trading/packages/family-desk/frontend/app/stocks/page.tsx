import type { Metadata } from "next";
import { Suspense } from "react";
import { StocksScreen } from "@/components/fundamental/stocks/StocksScreen";
import { StocksMobile } from "@/components/mobile/StocksMobile";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Stocks" };

export default function StocksPage() {
  // The desktop screen reads `?symbol=` with useSearchParams, which needs a Suspense boundary for the static export.
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<StocksScreen />} mobile={<StocksMobile />} />
    </Suspense>
  );
}
