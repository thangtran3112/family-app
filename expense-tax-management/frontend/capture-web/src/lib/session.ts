export type CaptureScope =
  | { kind: "personal"; profileId: string; label: string }
  | { kind: "business"; businessId: string; label: string };

export interface CaptureSession {
  apiBaseUrl: string;
  tenantToken: string;
  tenantId: string;
  scope: CaptureScope;
}

const KEY = "expense-tax-capture-session";

export function readSession(): CaptureSession | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CaptureSession;
  } catch {
    return null;
  }
}

export function writeSession(session: CaptureSession): void {
  sessionStorage.setItem(KEY, JSON.stringify(session));
}

export const demoScope: CaptureScope = {
  kind: "business",
  businessId: "33333333-3333-4333-8333-333333333333",
  label: "Tran Studio",
};
