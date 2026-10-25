import type { Metadata } from "next";
import { DashboardScreen } from "@/components/dashboard/DashboardScreen";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { TodayDashboard } from "../components/today/TodayDashboard.tsx";

// The root layout's title template does not apply to the page in its own segment.
export const metadata: Metadata = { title: { absolute: "Today - Family Desk" } };

export default function HomePage() {
  return <DeskResponsive desktop={<DashboardScreen />} mobile={<TodayDashboard />} />;
}
