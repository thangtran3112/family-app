import type { Tone } from "../../components/ui/tone.ts";
import { formatMetric, signTone, type MetricFormat } from "./format.ts";

// The behaviour the components/ui primitives own, kept pure so node --test can check it (the components render it).

/** A loading button is disabled and says so (`aria-busy`): a second click cannot repeat the request. */
export function buttonState({ disabled = false, loading = false }: { disabled?: boolean; loading?: boolean }): { disabled: boolean; "aria-busy": true | undefined } {
  return { disabled: disabled || loading, "aria-busy": loading ? true : undefined };
}

/** A count badge shows at most `max`, then "9+": the shell's bell never grows past two characters. */
export function countText(count: number, max = 9): string {
  return count > max ? `${max}+` : String(Math.max(0, Math.trunc(count)));
}

/** A delta is its signed text and a tone; the tone defaults to the sign of the value, so colour only repeats what the text says. */
export function deltaView(value: number | null | undefined, format: MetricFormat = "pct_signed", tone?: Tone): { text: string; tone: Tone } {
  return { text: formatMetric(format, value), tone: tone ?? signTone(value) };
}

/** A failure interrupts (`alert`); every other callout waits its turn (`status`). */
export const bannerRole = (tone: Tone): "alert" | "status" => (tone === "down" ? "alert" : "status");

/** A tile with a destination is a link; one without is read-only: no link, no hover (02m §e futures tiles). */
export const statTileTag = (href: string | undefined): "a" | "div" => (href ? "a" : "div");

/** The tag a panel title renders: h2 to h4. A panel is never the page's h1, and never deeper than a card. */
export function panelHeadingTag(level: number | undefined): "h2" | "h3" | "h4" {
  return level === 3 ? "h3" : level === 4 ? "h4" : "h2";
}

/** An icon is decoration (`aria-hidden`) unless it carries a label, then it is an image with that name. */
export function iconA11y(label: string | undefined): { "aria-hidden": true; role?: undefined; "aria-label"?: undefined } | { "aria-hidden"?: undefined; role: "img"; "aria-label": string } {
  return label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
}
