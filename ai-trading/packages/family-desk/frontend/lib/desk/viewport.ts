// Breakpoints of the desktop shell (02m §c1). The same two numbers drive the CSS media queries in
// globals.css; `bandForWidth` is the JavaScript twin used by the shell switch and `useViewportBand`.
export const DESKTOP_MIN_WIDTH = 1100;
export const WIDE_MIN_WIDTH = 1440;

export type ViewportBand = "mobile" | "1180" | "1440";
/** The desktop bands only: what components that drop columns care about. */
export type ShellBand = Exclude<ViewportBand, "mobile">;

export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;
export const WIDE_QUERY = `(min-width: ${WIDE_MIN_WIDTH}px)`;

export function bandForWidth(width: number): ViewportBand {
  if (width >= WIDE_MIN_WIDTH) return "1440";
  if (width >= DESKTOP_MIN_WIDTH) return "1180";
  return "mobile";
}

export const toShellBand = (band: ViewportBand): ShellBand => (band === "1440" ? "1440" : "1180");
