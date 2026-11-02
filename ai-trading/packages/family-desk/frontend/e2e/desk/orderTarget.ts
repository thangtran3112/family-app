// Which links count as an order control for the Desk's screen guard (`expectCleanScreen`). Pure, so `lib/desk/orderTarget.test.ts` covers it
// without a browser; the guard passes both sources into the page.

/** An address that is an order, position, broker, trade or paper-trading route. */
export const ORDER_TARGET = /\/(orders?|positions?|broker|trade|trading)(\/|\?|$)|\/(paper|backtests)(\/|\?|$)/i;

/** True when `href` leads to an order screen. The Desk has no Order page: orders are placed on the chart, so `/practice/order` is one too. */
export const isOrderTarget = (href: string): boolean => ORDER_TARGET.test(href);
