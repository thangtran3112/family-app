"use client";

import { useEffect } from "react";
import { warnBeforeUnload } from "@/lib/desk/unsavedGuard";
import { useDeskUiOptional } from "./DeskContext";

/**
 * One dirty guard for every form: while `dirty`, the shell asks before in-page navigation (the search box, the mode menu) drops
 * the form, and the browser asks before the tab closes or reloads. Works outside the desktop shell too (only the browser prompt then).
 */
/** `undefined` means the caller guards itself: nothing happens. */
export function useUnsavedGuard(dirty: boolean | undefined): void {
  const setShellDirty = useDeskUiOptional()?.setDirty;
  useEffect(() => {
    if (dirty === undefined) return;
    setShellDirty?.(dirty);
    return () => setShellDirty?.(false);
  }, [dirty, setShellDirty]);
  useEffect(() => {
    if (!dirty) return;
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);
}
