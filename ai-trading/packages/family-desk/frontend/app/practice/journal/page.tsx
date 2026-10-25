import type { Metadata } from "next";
import { Suspense } from "react";
import { JournalRoute } from "@/components/practice/journal/JournalRoute";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Practice journal" };

export default function PracticeJournalPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<JournalRoute />} />
    </Suspense>
  );
}
