import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";
export const metadata: Metadata = { title: "ExpenseTax Office", description: "Business ledger, tax preparation, and exports." };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
