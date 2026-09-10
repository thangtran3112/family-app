import { describe, expect, it, vi } from "vitest";

import type { PlatformSession } from "./session";

const {
  fetchProviders,
  fetchModes,
  fetchQuotaPeriods,
  fetchReconciliationQueue,
  fetchAudit,
} = vi.hoisted(() => ({
  fetchProviders: vi.fn(),
  fetchModes: vi.fn(),
  fetchQuotaPeriods: vi.fn(),
  fetchReconciliationQueue: vi.fn(),
  fetchAudit: vi.fn(),
}));
vi.mock("./api", () => ({
  fetchProviders,
  fetchModes,
  fetchQuotaPeriods,
  fetchReconciliationQueue,
  fetchAudit,
}));

import {
  loadAudit,
  loadModes,
  loadProviders,
  loadQuotas,
  loadReconciliation,
} from "./page-data";

const session: PlatformSession = { baseUrl: "http://foundry.test", role: "catalog_manager" };
const getToken = vi.fn();

describe("Foundry page data boundaries", () => {
  it.each([
    [loadProviders, fetchProviders],
    [loadModes, fetchModes],
    [loadQuotas, fetchQuotaPeriods],
    [loadReconciliation, fetchReconciliationQueue],
    [loadAudit, fetchAudit],
  ])("passes Clerk token getter to page API loader", async (loader, api) => {
    api.mockResolvedValue({ items: [] });

    await loader(session, getToken);

    expect(api).toHaveBeenCalledWith(session, getToken);
  });
});
