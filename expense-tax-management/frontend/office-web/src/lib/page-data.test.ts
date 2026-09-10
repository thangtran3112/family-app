import { describe, expect, it, vi } from "vitest";

import type { OfficeSession } from "./session";

const { fetchLedger, fetchTaxReport } = vi.hoisted(() => ({
  fetchLedger: vi.fn(),
  fetchTaxReport: vi.fn(),
}));
vi.mock("./api", () => ({ fetchLedger, fetchTaxReport }));

import { loadDashboard, loadExpenses, loadTax, loadTaxForOffice } from "./page-data";

const session: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  businessId: "business-1",
  label: "Family",
};
const getToken = vi.fn();

describe("Office page data boundaries", () => {
  it("loads dashboard ledger through Clerk-aware API helper", async () => {
    fetchLedger.mockResolvedValue({ items: [] });

    await loadDashboard(session, getToken, "org_123");

    expect(fetchLedger).toHaveBeenCalledWith(session, getToken, "org_123");
  });

  it("loads tax report through Clerk-aware API helper", async () => {
    fetchTaxReport.mockResolvedValue({ taxYear: 2025 });

    await loadTax(session, getToken, "org_123", 2025);

    expect(fetchTaxReport).toHaveBeenCalledWith(session, 2025, getToken, "org_123");
  });

  it("loads expenses through same ledger boundary", async () => {
    fetchLedger.mockResolvedValue({ items: [] });

    await loadExpenses(session, getToken, "org_123");

    expect(fetchLedger).toHaveBeenCalledWith(session, getToken, "org_123");
  });

  it("provides stable tax loader without a render-created callback", () => {
    expect(loadTaxForOffice).toBeTypeOf("function");
  });
});
