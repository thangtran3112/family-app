"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { isPracticePath, isReplayWorkspacePath, isWrongLane } from "@/lib/lanes";
import type { ShellBand } from "@/lib/desk/viewport";
import { DeskStatusProvider, DeskUiProvider, LeftSlotContext, RailSlotContext, useDeskUi } from "./DeskContext";
import { LeftRail } from "./LeftRail";
import { PracticeBand, PracticeChromeProvider } from "./PracticeChrome";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";
import { WrongLaneInterstitial } from "./WrongLaneInterstitial";
import leftStyles from "./leftrail.module.css";

/** The desktop shell (>= 1100 px, 02m §c1): 48 px top bar, left rail, center, right rail slot, 24 px status bar. */
export function DesktopShell({ band, children }: { band: ShellBand; children: ReactNode }) {
  return (
    <DeskStatusProvider>
      <DeskUiProvider>
        <PracticeChromeProvider>
          <ShellFrame band={band}>{children}</ShellFrame>
        </PracticeChromeProvider>
      </DeskUiProvider>
    </DeskStatusProvider>
  );
}

function ShellFrame({ band, children }: { band: ShellBand; children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { lane, leftCollapsed } = useDeskUi();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [leftSlot, setLeftSlot] = useState<HTMLElement | null>(null);
  // Practice pages (02o §a1) get the amber band; the replay workspace swaps the watchlists for its Session panel.
  const practice = isPracticePath(pathname);
  const replay = isReplayWorkspacePath(pathname);

  return (
    <RailSlotContext.Provider value={slot}>
      <LeftSlotContext.Provider value={replay ? leftSlot : null}>
      <div className="dk-shell" data-band={band} data-left={leftCollapsed && !replay ? "collapsed" : "open"} data-practice={practice ? "true" : undefined}>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div className="dk-top"><TopBar band={band} /></div>
        {practice && <div className="dk-band"><PracticeBand /></div>}
        <div className="dk-left">
          {replay ? <aside className={leftStyles.root} aria-label="Practice session" ref={setLeftSlot} /> : <LeftRail band={band} />}
        </div>
        <div className="dk-center" id="main-content" tabIndex={-1}>
          {isWrongLane(lane, pathname) ? <WrongLaneInterstitial pathname={pathname} /> : children}
        </div>
        <aside className="dk-right" ref={setSlot} aria-label="Context" />
        <div className="dk-status"><StatusBar /></div>
      </div>
      </LeftSlotContext.Provider>
    </RailSlotContext.Provider>
  );
}
