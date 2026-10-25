import type { Metadata } from "next";
import { Suspense } from "react";
import { DayListScreen } from "@/components/practice/day/DayListScreen";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Practice day" };

export default function PracticeDayPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<DayListScreen />} />
    </Suspense>
  );
}
