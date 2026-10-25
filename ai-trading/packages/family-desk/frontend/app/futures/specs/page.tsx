import type { Metadata } from "next";
import { FuturesSpecsScreen } from "@/components/futures/FuturesSpecsScreen";

export const metadata: Metadata = { title: "Futures specs" };

export default function FuturesSpecsPage() {
  return <FuturesSpecsScreen />;
}
