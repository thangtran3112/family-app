import type { Metadata } from "next";
import { CoveredCallsScreen } from "@/components/fundamental/covered-calls/CoveredCallsScreen";
import { CoveredCallsMobile } from "@/components/mobile/CoveredCallsMobile";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Covered calls" };

export default function CoveredCallsPage() {
  return <DeskResponsive desktop={<CoveredCallsScreen />} mobile={<CoveredCallsMobile />} />;
}
