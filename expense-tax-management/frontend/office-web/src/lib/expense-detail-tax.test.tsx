// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchExpenseDetail, fetchSuggestions, readOfficeSession } = vi.hoisted(() => ({
  fetchExpenseDetail: vi.fn(),
  fetchSuggestions: vi.fn(),
  readOfficeSession: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  fetchExpenseDetail,
  fetchSuggestions,
}));
vi.mock("@/lib/session", () => ({ readOfficeSession }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn(), isLoaded: true, isSignedIn: true }),
  useOrganization: () => ({ organization: { id: "org_1" }, isLoaded: true }),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ expenseId: "exp-1" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import ExpenseDetail from "@/app/(office)/expenses/[expenseId]/page";

describe("expense detail tax amount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readOfficeSession.mockReturnValue({
      apiBaseUrl: "http://app.test",
      tenantId: "tenant-1",
      scope: { kind: "business", businessId: "business-1" },
      label: "Business",
    });
    fetchSuggestions.mockResolvedValue({ items: [], nextCursor: null });
  });

  afterEach(() => cleanup());

  it.each([
    ["5.53", "Tax: 5.53 CAD"],
    ["0.00", "Tax: 0.00 CAD"],
    [null, "Tax: Not recorded"],
  ] as const)("renders tax %s", async (taxAmount, expected) => {
    fetchExpenseDetail.mockResolvedValue({
      id: "exp-1",
      merchant: "Shop",
      incurredOn: "2026-09-01",
      amount: "10.00",
      taxAmount,
      currency: "CAD",
      status: "ready",
      version: 1,
      tags: [],
    });

    render(<ExpenseDetail />);

    expect(await screen.findByText(expected)).toBeTruthy();
  });
});
