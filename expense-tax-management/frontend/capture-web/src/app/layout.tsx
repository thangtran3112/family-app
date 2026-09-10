import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { requireClerkPublishableKey } from "@/lib/clerk";

import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import "./styles.css";

export const metadata: Metadata = {
  title: { default: "ExpenseTax Capture", template: "%s · ExpenseTax Capture" },
  description: "Capture, queue, and review receipts from a phone or tablet.",
  applicationName: "ExpenseTax Capture",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#08100f",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ClerkProvider publishableKey={requireClerkPublishableKey(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)}>
          <ServiceWorkerRegistration />
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
