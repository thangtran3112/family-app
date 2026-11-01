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

export type FieldWiring = {
  /** The id of the message line under the control; null when the field has none (so `aria-describedby` points at nothing). */
  messageId: string | null;
  describedBy: string | undefined;
  invalid: true | undefined;
  message: string | null;
  /** An error announces itself (`role="alert"`); a note does not. */
  alert: boolean;
};

/**
 * One field's accessibility wiring from one id: the message line is `${id}-error` while there is an error and `${id}-note`
 * otherwise, and it is the control's `aria-describedby`. An error replaces the note in the same line, so the form never
 * grows when it fails; `reserve` keeps the line (empty) for fields whose note comes and goes.
 */
export function fieldWiring({ id, note, error, reserve = false }: { id: string; note?: string | null; error?: string | null; reserve?: boolean }): FieldWiring {
  if (error) return { messageId: `${id}-error`, describedBy: `${id}-error`, invalid: true, message: error, alert: true };
  if (note) return { messageId: `${id}-note`, describedBy: `${id}-note`, invalid: undefined, message: note, alert: false };
  return { messageId: reserve ? `${id}-note` : null, describedBy: undefined, invalid: undefined, message: null, alert: false };
}

/** The cue beside a label: "Required", "Optional", then any hint, joined with a middle dot. Required wins over optional. */
export function requirementText({ required = false, optional = false, hint }: { required?: boolean; optional?: boolean; hint?: string }): string | null {
  const parts = [required ? "Required" : optional ? "Optional" : null, hint ?? null].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}

export const UNSAVED_TEXT = "You have unsaved changes";

/** What the form bar says on the left: the screen's own status, else "You have unsaved changes" while dirty, else nothing. */
export function formBarStatus<T>({ dirty = false, status }: { dirty?: boolean; status?: T | null }): T | string | null {
  return status ?? (dirty ? UNSAVED_TEXT : null);
}

/**
 * Roving focus for Segmented and Tabs, the contract `technicals/TimeframeTabs` set: the arrows move one step and wrap, Home and End jump to
 * the ends. A disabled index is skipped. Returns the index to move to, or null when the key is not a move (or nothing can take focus).
 * `axis: "horizontal"` listens to Left and Right only (tabs); the default also takes Up and Down (a radio group).
 */
export function rovingTarget(key: string, index: number, count: number, options: { enabled?: ReadonlyArray<boolean>; axis?: "horizontal" | "any" } = {}): number | null {
  const { enabled, axis = "any" } = options;
  const forward = key === "ArrowRight" || (axis === "any" && key === "ArrowDown");
  const back = key === "ArrowLeft" || (axis === "any" && key === "ArrowUp");
  const step = forward || key === "Home" ? 1 : back || key === "End" ? -1 : 0;
  if (step === 0 || count <= 0) return null;
  let at = key === "Home" ? -1 : key === "End" ? count : index;
  for (let tries = 0; tries < count; tries += 1) {
    at = (at + step + count) % count;
    if (enabled?.[at] !== false) return at;
  }
  return null;
}

/** The index that takes Tab focus in a roving group: the selected one, else the first that is not disabled (so the group is never skipped). */
export function rovingStop(selected: number, enabled: ReadonlyArray<boolean>): number {
  if (selected >= 0 && selected < enabled.length && enabled[selected]) return selected;
  return Math.max(0, enabled.findIndex((on) => on));
}

/** The DOM ids a tab and its panel share: the tab names its panel (`aria-controls`) and the panel names its tab (`aria-labelledby`). */
export const tabDomIds = (base: string, id: string): { tab: string; panel: string } => ({ tab: `${base}-tab-${id}`, panel: `${base}-panel-${id}` });

/** A control that opens a mode (Manage, Edit) says "Done" while the mode is open, instead of looking pressed: nothing is switched on, the screen changed. */
export const modeLabel = (label: string, open: boolean): string => (open ? "Done" : label);

/** What a RailList row is: a link when it has an `href`, a button when it has `onSelect`, else plain text. A row that looks clickable is never plain text. */
export function railRowKind(row: { href?: string; onSelect?: () => void }): "link" | "button" | "text" {
  if (row.href !== undefined) return "link";
  return row.onSelect === undefined ? "text" : "button";
}

/** The selected row of a list is marked the way its element allows: `aria-current` on a link, `aria-pressed` on a button, nothing on text. */
export function railRowSelection(kind: "link" | "button" | "text", selected: boolean): { "aria-current"?: "page"; "aria-pressed"?: boolean } {
  if (kind === "link") return { "aria-current": selected ? "page" : undefined };
  if (kind === "button") return { "aria-pressed": selected };
  return {};
}

/** How many columns a FactList lays out: one is the default, two only when asked (a wide panel); anything else is one. */
export const factColumns = (columns: number | undefined): 1 | 2 => (columns === 2 ? 2 : 1);

/** The label shown while a QueryBoundary retry is in flight: it says what is happening instead of staying "Try again". */
export const retryLabel = (retrying: boolean): string => (retrying ? "Trying again" : "Try again");
