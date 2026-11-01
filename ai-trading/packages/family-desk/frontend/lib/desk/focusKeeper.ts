// Where the keyboard lands when a page changes or the control it was on leaves the page (D-093). Pure, so `node --test` covers it;
// `components/shell/MainFocus.tsx` is the only caller.

type Region = Pick<HTMLElement, "contains" | "querySelector">;

/** The page's own h1 when it has one, else the main region itself (`#main-content`, `tabindex="-1"`). */
export function focusTarget<T extends Region>(main: T): HTMLElement | T {
  return main.querySelector<HTMLElement>("h1") ?? main;
}

/**
 * Focus has no good home. It is on the document body (the control was removed, or a navigation dropped it), or on nothing.
 * After a route change it also counts as lost when it still sits outside the page (a rail link, the search box): the new page starts there.
 * Focus already inside the page is never lost: the page, or the user, put it there.
 */
export function focusLost(active: Element | null, body: Element, main: Region & Element, routeChanged: boolean): boolean {
  if (active === null || active === body) return true;
  if (!routeChanged) return false;
  return active === main || !main.contains(active);
}
