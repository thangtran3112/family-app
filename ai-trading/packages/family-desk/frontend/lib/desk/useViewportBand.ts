"use client";

import { useSyncExternalStore } from "react";
import { DESKTOP_QUERY, WIDE_QUERY, toShellBand, type ShellBand, type ViewportBand } from "./viewport.ts";

function subscribe(onChange: () => void): () => void {
  const queries = [window.matchMedia(DESKTOP_QUERY), window.matchMedia(WIDE_QUERY)];
  queries.forEach((query) => query.addEventListener("change", onChange));
  return () => queries.forEach((query) => query.removeEventListener("change", onChange));
}

function snapshot(): ViewportBand {
  if (window.matchMedia(WIDE_QUERY).matches) return "1440";
  return window.matchMedia(DESKTOP_QUERY).matches ? "1180" : "mobile";
}

// The static export is rendered once for mobile; the desktop shell takes over after hydration.
export function useViewportBand(): ViewportBand {
  return useSyncExternalStore(subscribe, snapshot, () => "mobile");
}

/** `"1440" | "1180"` for components that drop columns (02m §c1). Mobile reads as 1180. */
export function useShellBand(): ShellBand {
  return toShellBand(useViewportBand());
}
