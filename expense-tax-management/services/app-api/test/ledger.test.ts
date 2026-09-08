import { describe, expect, it } from "vitest";

import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  ledgerFilterHash,
} from "../src/pagination/cursor.js";

const SCOPE = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  businessId: "22222222-2222-4222-8222-222222222222",
};

describe("Phase 0J ledger cursor", () => {
  it("round-trips opaque keyset state", () => {
    const query = {
      incurredFrom: "2025-01-01",
      incurredTo: "2025-12-31",
      sort: "amount" as const,
      direction: "desc" as const,
      limit: 25,
    };
    const cursor = encodeLedgerCursor({
      scope: SCOPE,
      filterHash: ledgerFilterHash(query),
      sort: "amount",
      direction: "desc",
      lastValue: "42.00",
      lastId: "33333333-3333-4333-8333-333333333333",
    });

    expect(cursor).not.toContain("amount");
    expect(decodeLedgerCursor(cursor)).toMatchObject({
      scope: SCOPE,
      sort: "amount",
      direction: "desc",
      lastValue: "42.00",
    });
  });

  it("rejects malformed and tampered cursor payloads", () => {
    expect(() => decodeLedgerCursor("not-base64-json")).toThrow();
    const cursor = encodeLedgerCursor({
      scope: SCOPE,
      filterHash: "a".repeat(64),
      sort: "incurredOn",
      direction: "asc",
      lastValue: "2025-01-01",
      lastId: "33333333-3333-4333-8333-333333333333",
    });
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    expect(() => decodeLedgerCursor(tampered)).toThrow();
  });

  it("changes filter hash when any query filter changes", () => {
    expect(
      ledgerFilterHash({ sort: "amount", direction: "desc", limit: 25 }),
    ).not.toBe(
      ledgerFilterHash({ sort: "amount", direction: "asc", limit: 25 }),
    );
  });
});
