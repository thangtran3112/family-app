import type { Metadata } from "next";
import { HoldingsScreen } from "@/components/fundamental/holdings/HoldingsScreen";
import { HoldingsMobile } from "@/components/mobile/HoldingsMobile";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Holdings" };

export default function HoldingsPage() {
  return <DeskResponsive desktop={<HoldingsScreen />} mobile={<HoldingsMobile />} />;
}
