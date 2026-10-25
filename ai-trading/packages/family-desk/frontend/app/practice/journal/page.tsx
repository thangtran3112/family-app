import type { Metadata } from "next";
import { Suspense } from "react";
import { JournalScreen } from "@/components/practice/journal/JournalScreen";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Practice journal" };

export default function PracticeJournalPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<JournalScreen />} />
    </Suspense>
  );
}
