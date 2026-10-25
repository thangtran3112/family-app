import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "New strategy" };

export default function NewStrategyLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
