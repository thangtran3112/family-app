import { Suspense } from "react";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { LibraryScreen } from "@/components/library/LibraryScreen";

export default function LibraryPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<LibraryScreen />} />
    </Suspense>
  );
}
