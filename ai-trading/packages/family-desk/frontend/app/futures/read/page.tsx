import type { Metadata } from "next";
import { FuturesReadScreen } from "@/components/fundamental/futures/FuturesReadScreen";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Futures reading" };

export default function FuturesReadPage() {
  return <DeskResponsive desktop={<FuturesReadScreen />} />;
}
