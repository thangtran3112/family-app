import { EMPTY_VALUE } from "./format.ts";

// Value masking for the Fundamental lane (02n §b1). The API returns real values; hiding is a render rule: dollar
// amounts, share counts and contract counts become `•••••`, while prices per share, percentages, dates and symbols
// stay visible. Every component that prints one of those three goes through a function here.
export const MASK = "•••••";
export const DEFAULT_MASK_VALUES = true;

type SettingsRecord = Record<string, unknown>;

/** Hidden unless the owner turned the default off (`mask_values: false`). */
export const readMaskValues = (settings: SettingsRecord): boolean => settings.mask_values !== false;
export const withMaskValues = (settings: SettingsRecord, masked: boolean): SettingsRecord => ({ ...settings, mask_values: masked });

const MINUS = "−";
const isNumber = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/** "$208,260" (whole dollars) or "$1,234.50" with `cents`; the sign is a leading minus. */
export function formatUsd(value: number | null | undefined, { cents = false }: { cents?: boolean } = {}): string {
  if (!isNumber(value)) return EMPTY_VALUE;
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  return `${value < 0 && Number(text.replace(/,/g, "")) !== 0 ? MINUS : ""}$${text}`;
}

/** "+$1,204" / "−$310": a change in dollars. */
export function formatSignedUsd(value: number | null | undefined, { cents = false }: { cents?: boolean } = {}): string {
  if (!isNumber(value)) return EMPTY_VALUE;
  const text = formatUsd(Math.abs(value), { cents });
  if (Number(text.replace(/[$,]/g, "")) === 0) return text;
  return `${value > 0 ? "+" : MINUS}${text}`;
}

/** "$231.40": a per-share price, never masked. */
export const formatUsdPrice = (value: number | null | undefined): string => formatUsd(value, { cents: true });

/** "1,250" shares or contracts. Fractional shares keep up to four places. */
export function formatQuantity(value: number | null | undefined): string {
  if (!isNumber(value)) return EMPTY_VALUE;
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Dollar amounts: `•••••` while values are hidden, "—" for a missing value even then (nothing to hide). */
export function maskedUsd(masked: boolean, value: number | null | undefined, options?: { cents?: boolean }): string {
  if (!isNumber(value)) return EMPTY_VALUE;
  return masked ? MASK : formatUsd(value, options);
}

export function maskedSignedUsd(masked: boolean, value: number | null | undefined, options?: { cents?: boolean }): string {
  if (!isNumber(value)) return EMPTY_VALUE;
  return masked ? MASK : formatSignedUsd(value, options);
}

/** Share and contract counts. */
export function maskedQuantity(masked: boolean, value: number | null | undefined): string {
  if (!isNumber(value)) return EMPTY_VALUE;
  return masked ? MASK : formatQuantity(value);
}

/** A sentence that carries a count or an amount ("120 shares: under one contract at a 50% cap") hides whole while masked. */
export const maskedText = (masked: boolean, text: string): string => (masked ? MASK : text);
