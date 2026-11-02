// Which links count as an order control for the Desk's screen guard (`expectCleanScreen`). Pure, so `lib/desk/orderTarget.test.ts` covers it
// without a browser; the guard passes both sources into the page.

/** An address that is an order, position, broker, trade or paper-trading route. */
export const ORDER_TARGET = /\/(orders?|positions?|broker|trade|trading)(\/|\?|$)|\/(paper|backtests)(\/|\?|$)/i;

/**
 * The Order tab's own pick-a-stock page (D-190): `/practice/order?thread=<id>`, the address a thread picker row links to. It lists a
 * thread's names and opens no ticket and no broker (ADR-0016 allows the replay ticket's two paths and nothing else). Only this exact
 * address is let through: any other `/practice/order?…` stays an order target.
 */
export const ORDER_TAB_ADDRESS = /^\/practice\/order\?thread=\d+$/;

/** True when `href` leads to an order screen, the Order tab's picker address aside. */
export const isOrderTarget = (href: string): boolean => ORDER_TARGET.test(href) && !ORDER_TAB_ADDRESS.test(href);
