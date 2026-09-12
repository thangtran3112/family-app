import { fetchDuplicateMatches, fetchLedger, fetchTaxReport } from "./api";
import type { ClerkGetToken } from "./clerk";
import type { OfficeSession } from "./session";

export function loadDashboard(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return fetchLedger(session, getToken, organizationId);
}

export function loadExpenses(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return fetchLedger(session, getToken, organizationId);
}

export function loadTax(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  taxYear: number,
) {
  return fetchTaxReport(session, taxYear, getToken, organizationId);
}

export function loadTaxForOffice(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return loadTax(session, getToken, organizationId, 2025);
}

export function loadDuplicates(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  cursor?: string,
) {
  return fetchDuplicateMatches(session, getToken, organizationId, undefined, cursor);
}
