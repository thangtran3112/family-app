import { EMPTY_VALUE, type Tone } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { moneyTone } from "./journalView.ts";
import type { ClockAccount } from "./threadClock.ts";
import type { PracticeThread } from "./threads.ts";

// View logic of the practice-thread screens (02r, ADR-0025): money text, the thread's name and started-with line, the weeks of
// the journal, the improvement panel and its too-few-days caveat, and the summary tiles. Every dollar figure is SIMULATED. A date is an ET
// calendar date, a label and a grouping key only ("Wed 2026-03-11"); it never ends or resets anything.

const MINUS = "−";
const ET = "America/New_York";

const cents = (value: number) => Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (value: number) => Math.abs(Math.round(value)).toLocaleString("en-US");

// One money rule (D-044): every dollar figure is dollars and cents, so the journal, the hub and the trade lines
// agree to the cent. Only an axis tick may drop the cents (`formatAxisDollars`).

/** "$50,123.40": a balance, dollars and cents. */
export function formatBalance(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_VALUE;
  const text = cents(value);
  return `${value < 0 && Number(text.replaceAll(",", "")) !== 0 ? MINUS : ""}$${text}`;
}

/** "+$1,565.00" / "−$246.60" / "$0.00": a day's result or the change in a balance; the sign is the cue. */
export function formatDayResult(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_VALUE;
  if (Number(cents(value).replaceAll(",", "")) === 0) return "$0.00";
  return `${value > 0 ? "+" : MINUS}$${cents(value)}`;
}

/** "$50,000": an amount she chose (starting balance, max loss), whole dollars; a figure the ledger produced uses `formatBalance`. */
export const formatWhole = (value: number): string => `${value < 0 ? MINUS : ""}$${whole(value)}`;

/** "$50,123" / "+$1,565" / "−$247": an axis tick, whole dollars (a scale, not a figure to read to the cent). */
export function formatAxisDollars(value: number, signed = false): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "$0";
  return `${rounded < 0 ? MINUS : signed ? "+" : ""}$${whole(value)}`;
}

export const dayResultTone = (value: number | null | undefined): Tone => moneyTone(value);

const monthDay = new Intl.DateTimeFormat("en-US", { timeZone: ET, month: "short", day: "numeric" });

/** The thread's own name, as the server gave it when the thread started: "Freestyle · Oct 15", and "(2)" on a later thread of that
 *  day, so two threads never read the same (D-069). A thread that started before the freestyle model keeps its old name. */
export const threadName = (thread: Pick<PracticeThread, "name">): string => thread.name;

/** "Started Oct 25": the day she started it (the day she made the thread, not a replayed day). */
export const threadStartedText = (thread: Pick<PracticeThread, "createdAt">): string => `Started ${monthDay.format(new Date(thread.createdAt))}`;

/** "Started with $50,000 · +$123 so far". A thread with a position open at the clock counts its open P/L apart, so "no change yet"
 *  beside a higher Equity never reads as a flat thread (D-170). */
export function startedWithText(
  thread: Pick<PracticeThread, "startingBalance" | "stats">,
  account?: Pick<ClockAccount, "balance" | "positions" | "open_pnl_usd"> | null,
): string {
  const change = thread.stats.balance - thread.startingBalance;
  const start = formatWhole(thread.startingBalance);
  if (account && account.positions > 0) {
    // The account's own balance: it is read with the open P/L, so the two always add up to the headline's Equity.
    return practiceText("threadStartedOpen", { start, realized: formatDayResult(account.balance - thread.startingBalance), open: formatDayResult(account.open_pnl_usd) });
  }
  return Math.round(change) === 0
    ? practiceText("threadStartedFlat", { start })
    : practiceText("threadStartedWith", { start, change: formatDayResult(change) });
}

/** "64%" from a 0..1 share, or a dash with no closed trade. */
export const winRateText = (rate: number | undefined): string => (rate === undefined ? EMPTY_VALUE : `${Math.round(rate * 100)}%`);

/** The big figure on the Summary and its word (D-156, ADR-0018). With the clock account read it shows the thread's equity and says "Equity":
 *  the ledger balance plus every open position priced at the clock. Without one (a closed thread, the clock not read yet) it is the
 *  ledger balance and says "Balance". "Balance" is always the realized figure; one word, one number. */
export function headlineFigure(balance: number, account: Pick<ClockAccount, "equity_usd"> | null): { label: string; value: string } {
  return account === null ? { label: PRACTICE_COPY.threadBalance, value: formatBalance(balance) } : { label: PRACTICE_COPY.clockAccountEquity, value: formatBalance(account.equity_usd) };
}
