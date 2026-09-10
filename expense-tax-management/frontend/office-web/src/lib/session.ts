export interface OfficeSession {
  apiBaseUrl: string;
  tenantId: string;
  businessId: string;
  label: string;
}
export function readOfficeSession(): OfficeSession | null {
  if (typeof sessionStorage === "undefined") return null;
  try { return JSON.parse(sessionStorage.getItem("expense-tax-office-session") ?? "null") as OfficeSession | null; } catch { return null; }
}
