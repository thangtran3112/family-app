"use client";

import type { ReactNode } from "react";
import { useViewportBand } from "@/lib/desk/useViewportBand";
import { DesktopOnlyNotice } from "./DesktopOnlyNotice";

/**
 * A page that has a desktop screen and, optionally, an existing mobile screen. Below 1100 px the mobile
 * node (or the desktop-only notice) renders; the desktop screen only mounts once the shell is desktop.
 */
export function DeskResponsive({ desktop, mobile }: { desktop: ReactNode; mobile?: ReactNode }) {
  const band = useViewportBand();
  if (band !== "mobile") return desktop;
  return mobile ?? <DesktopOnlyNotice />;
}
