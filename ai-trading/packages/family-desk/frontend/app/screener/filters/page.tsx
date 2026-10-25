import type { Metadata } from "next";
import { Suspense } from "react";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { FilterEditor } from "@/components/screener/editor/FilterEditor";

export const metadata: Metadata = { title: "Filter editor" };

export default function FilterEditorPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<FilterEditor />} />
    </Suspense>
  );
}
