import type { Metadata } from "next";
import { Suspense } from "react";
import { OrderPage } from "@/components/practice/hub/OrderPage";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Practice order" };

export default function PracticeOrderPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<OrderPage />} />
    </Suspense>
  );
}
