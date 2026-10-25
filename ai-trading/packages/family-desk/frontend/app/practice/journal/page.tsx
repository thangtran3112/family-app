import { Suspense } from "react";
import { JournalScreen } from "@/components/practice/journal/JournalScreen";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export default function PracticeJournalPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<JournalScreen />} />
    </Suspense>
  );
}
