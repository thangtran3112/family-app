import type { Metadata } from "next";
import { Suspense } from "react";
import { WeekRoute } from "@/components/practice/week/WeekRoute";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Weekly review" };

export default function PracticeWeekPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<WeekRoute />} />
    </Suspense>
  );
}
