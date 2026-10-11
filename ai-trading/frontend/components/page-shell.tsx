import type { ReactNode } from "react";
import { Header } from "@/components/header";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { AppControlsProvider } from "@/components/app-controls-provider";

export function PageShell({
  breadcrumb,
  scroll = true,
  children,
}: {
  breadcrumb?: string;
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    // One provider per authenticated page view: it owns app-controls
    // fetching/polling for everything below it (nav, cards, Settings,
    // detail launch guidance), and cleans up its timers when this page
    // unmounts on navigation, same as any other per-page client state.
    <AppControlsProvider>
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-4 focus-visible:left-4 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-accent focus-visible:px-4 focus-visible:py-2 focus-visible:text-on-accent"
      >
        Skip to content
      </a>
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar breadcrumb={breadcrumb} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header breadcrumb={breadcrumb} />
          <main id="main-content" tabIndex={-1} className={`flex min-h-0 flex-1 flex-col${scroll ? " overflow-y-auto" : ""}`}>
            {children}
          </main>
        </div>
      </div>
    </AppControlsProvider>
  );
}
