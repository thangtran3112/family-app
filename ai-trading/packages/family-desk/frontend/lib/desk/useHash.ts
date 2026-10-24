"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The URL hash without `#` ("chart", "summary"); empty on the server and when absent. */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash.replace(/^#/, ""), () => "");
}

export type TechnicalsView = "chart" | "summary";
/** `#chart` is the default; anything but `#summary` reads as the chart (02m §c1). */
export const viewFromHash = (hash: string): TechnicalsView => (hash === "summary" ? "summary" : "chart");
