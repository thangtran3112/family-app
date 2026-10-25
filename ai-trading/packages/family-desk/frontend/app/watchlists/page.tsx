import type { Metadata } from "next";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { WatchlistDesktop } from "@/components/watchlists/desktop/WatchlistDesktop";
import { WatchlistsMobile } from "@/components/watchlists/WatchlistsMobile";

export const metadata: Metadata = { title: "Watchlists" };

export default function WatchlistsPage() {
  return <DeskResponsive desktop={<WatchlistDesktop />} mobile={<WatchlistsMobile />} />;
}
