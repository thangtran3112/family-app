import {
  fetchAudit,
  fetchModes,
  fetchProviders,
  fetchQuotaPeriods,
  fetchReconciliationQueue,
} from "./api";
import type { ClerkGetToken } from "./clerk";
import type { PlatformSession } from "./session";

export const loadProviders = (session: PlatformSession, getToken: ClerkGetToken) =>
  fetchProviders(session, getToken);
export const loadModes = (session: PlatformSession, getToken: ClerkGetToken) =>
  fetchModes(session, getToken);
export const loadQuotas = (session: PlatformSession, getToken: ClerkGetToken) =>
  fetchQuotaPeriods(session, getToken);
export const loadReconciliation = (session: PlatformSession, getToken: ClerkGetToken) =>
  fetchReconciliationQueue(session, getToken);
export const loadAudit = (session: PlatformSession, getToken: ClerkGetToken) =>
  fetchAudit(session, getToken);
