import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { WatchlistDesktop } from "@/components/watchlists/desktop/WatchlistDesktop";
import { WatchlistsMobile } from "@/components/watchlists/WatchlistsMobile";

export default function WatchlistsPage() {
  return <DeskResponsive desktop={<WatchlistDesktop />} mobile={<WatchlistsMobile />} />;
}
