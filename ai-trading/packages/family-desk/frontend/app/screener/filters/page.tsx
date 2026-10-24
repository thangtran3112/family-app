import { Suspense } from "react";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { FilterEditor } from "@/components/screener/editor/FilterEditor";

export default function FilterEditorPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<FilterEditor />} />
    </Suspense>
  );
}
