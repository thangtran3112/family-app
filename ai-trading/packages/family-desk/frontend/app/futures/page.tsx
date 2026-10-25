import type { Metadata } from "next";
import { FuturesSwingScreen } from "@/components/futures/FuturesSwingScreen";

export const metadata: Metadata = { title: "Futures" };

export default function FuturesPage() {
  return <FuturesSwingScreen />;
}
