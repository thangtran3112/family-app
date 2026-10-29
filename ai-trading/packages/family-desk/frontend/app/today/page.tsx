import type { Metadata } from "next";
import { DashboardScreen } from "@/components/dashboard/DashboardScreen";
import { FundamentalToday } from "@/components/fundamental/today/FundamentalToday";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { LaneVariant } from "@/components/shell/desktop/LaneVariant";
import { TodayDashboard } from "@/components/today/TodayDashboard";

export const metadata: Metadata = { title: "Today" };

export default function TodayPage() {
  return <DeskResponsive desktop={<LaneVariant technical={<DashboardScreen />} fundamental={<FundamentalToday />} />} mobile={<TodayDashboard />} />;
}
