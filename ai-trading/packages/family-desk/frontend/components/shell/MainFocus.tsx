"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { focusLost, focusTarget } from "@/lib/desk/focusKeeper";

/** The h1 has no tabindex of its own on most pages; give it one so `focus()` takes. */
function moveFocus(main: HTMLElement, options?: FocusOptions) {
  const target = focusTarget(main);
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus(options);
}

/**
 * Keeps the keyboard inside the page (D-093). Both shells render it once, after `#main-content`; it draws nothing.
 * 1. A route change (path or query: End day, Next day, Start day and New plan submit all push one) moves focus to the new
 *    page's h1, else to `#main-content`, unless the page has already put focus on one of its own controls.
 * 2. When the focused control leaves the page (Buy becomes Next day) and focus drops to the body, focus goes to the same
 *    place, so the keyboard never restarts at the skip link and the chrome. A page that places focus itself wins: this runs a frame later.
 * Wrap it in Suspense: `useSearchParams` makes the nearest boundary client-rendered.
 */
export function MainFocus() {
  const route = `${usePathname()}?${useSearchParams()}`;
  const arrivedAt = useRef<string | null>(null);

  useEffect(() => {
    const main = document.getElementById("main-content");
    const first = arrivedAt.current === null;
    arrivedAt.current = route;
    // A page load keeps the browser's start: the skip link is the first stop there.
    if (first || !main || !focusLost(document.activeElement, document.body, main, true)) return;
    moveFocus(main);
  }, [route]);

  useEffect(() => {
    const main = document.getElementById("main-content");
    if (!main) return;
    let held: EventTarget | null = null; // ponytail: a click on bare page space keeps the old `held`; harmless, fixed when a real need shows up
    const onFocusIn = (event: FocusEvent) => {
      held = event.target;
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget) held = null; // focus moved to another control (inside the page, onFocusIn sets it again)
    };
    const watch = new MutationObserver(() => {
      if (!(held instanceof Node) || held.isConnected) return;
      held = null;
      requestAnimationFrame(() => {
        if (focusLost(document.activeElement, document.body, main, false)) moveFocus(main, { preventScroll: true });
      });
    });
    main.addEventListener("focusin", onFocusIn);
    main.addEventListener("focusout", onFocusOut);
    watch.observe(main, { childList: true, subtree: true });
    return () => {
      main.removeEventListener("focusin", onFocusIn);
      main.removeEventListener("focusout", onFocusOut);
      watch.disconnect();
    };
  }, []);

  return null;
}
