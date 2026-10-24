"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { isWrongLane } from "@/lib/lanes";
import type { ShellBand } from "@/lib/desk/viewport";
import { DeskStatusProvider, DeskUiProvider, RailSlotContext, useDeskUi } from "./DeskContext";
import { LeftRail } from "./LeftRail";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";
import { WrongLaneInterstitial } from "./WrongLaneInterstitial";

/** The desktop shell (>= 1100 px, 02m §c1): 48 px top bar, left rail, center, right rail slot, 24 px status bar. */
export function DesktopShell({ band, children }: { band: ShellBand; children: ReactNode }) {
  return (
    <DeskStatusProvider>
      <DeskUiProvider>
        <ShellFrame band={band}>{children}</ShellFrame>
      </DeskUiProvider>
    </DeskStatusProvider>
  );
}

function ShellFrame({ band, children }: { band: ShellBand; children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { lane, leftCollapsed } = useDeskUi();
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  return (
    <RailSlotContext.Provider value={slot}>
      <div className="dk-shell" data-band={band} data-left={leftCollapsed ? "collapsed" : "open"}>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div className="dk-top"><TopBar band={band} /></div>
        <div className="dk-left"><LeftRail band={band} /></div>
        <div className="dk-center" id="main-content" tabIndex={-1}>
          {isWrongLane(lane, pathname) ? <WrongLaneInterstitial pathname={pathname} /> : children}
        </div>
        <aside className="dk-right" ref={setSlot} aria-label="Context" />
        <div className="dk-status"><StatusBar /></div>
      </div>
    </RailSlotContext.Provider>
  );
}
