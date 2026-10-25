import type { Metadata } from "next";
import { DashboardScreen } from "@/components/dashboard/DashboardScreen";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { TodayDashboard } from "@/components/today/TodayDashboard";

export const metadata: Metadata = { title: "Today" };

export default function HomePage() {
  return <DeskResponsive desktop={<DashboardScreen />} mobile={<TodayDashboard />} />;
}
