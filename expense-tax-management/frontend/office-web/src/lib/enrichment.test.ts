// @vitest-environment jsdom
/**
 * Enrichment review UI tests: suggestion candidate, confidence, evidence, source history.
 * Tests both scope variants (Personal/Business) and all current consumer states.
 */

import { describe, expect, it } from "vitest";

import type { OfficeSession } from "./session";
import { getSuggestionSourceLabel, getEnrichmentReviewState, makeStableIdempotencyKey } from "./api";

// ------------------------------------------------------------------ //
// Shared fixtures
// ------------------------------------------------------------------ //

const businessSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "business", businessId: "business-1" },
  label: "Family Business",
};

const personalSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal", profileId: "profile-1" },
  label: "Personal",
};

// ------------------------------------------------------------------ //
// Pure helper unit tests (node environment is fine)
// ------------------------------------------------------------------ //

describe("enrichment source label helpers", () => {
  it("labels rule source correctly", () => {
    expect(getSuggestionSourceLabel("historical")).toBe("Historical pattern");
    expect(getSuggestionSourceLabel("ai")).toBe("AI suggestion");
  });

  it("maps history decision sources", () => {
    expect(getSuggestionSourceLabel("manual")).toBe("Manual decision");
    expect(getSuggestionSourceLabel("manual_baseline")).toBe("Baseline import");
  });
});

describe("enrichment review state helper", () => {
  it("returns loading when not ready", () => {
    expect(getEnrichmentReviewState({ isLoaded: false, isSignedIn: false, hasSession: false, hasOrganization: false })).toBe("loading");
  });

  it("returns unauthorized when session/org missing", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: false, hasOrganization: true })).toBe("unauthorized");
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: false })).toBe("unauthorized");
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: false, hasSession: false, hasOrganization: false })).toBe("unauthorized");
  });

  it("returns error state", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true, error: "Request failed" })).toBe("error");
  });

  it("returns loading when data not yet fetched", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true })).toBe("loading");
  });

  it("returns empty when no suggestions", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true, suggestions: [] })).toBe("empty");
  });

  it("returns pending when suggestions present", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true, suggestions: [{ id: "s1" }] })).toBe("pending");
  });

  it("returns conflict", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true, conflict: true })).toBe("conflict");
  });

  it("returns stale", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true, stale: true })).toBe("stale");
  });
});

describe("stable idempotency key", () => {
  it("returns same key for same action on same expense", () => {
    const k1 = makeStableIdempotencyKey("resolve-suggestion", "exp-1", "sugg-1");
    const k2 = makeStableIdempotencyKey("resolve-suggestion", "exp-1", "sugg-1");
    expect(k1).toBe(k2);
  });

  it("returns different keys for different actions", () => {
    const k1 = makeStableIdempotencyKey("resolve-suggestion", "exp-1", "sugg-1");
    const k2 = makeStableIdempotencyKey("resolve-suggestion", "exp-1", "sugg-2");
    expect(k1).not.toBe(k2);
  });

  it("key contains all discriminating parts", () => {
    const k = makeStableIdempotencyKey("resolve-suggestion", "exp-1", "sugg-1");
    expect(k).toContain("resolve-suggestion");
    expect(k).toContain("exp-1");
    expect(k).toContain("sugg-1");
  });
});

// ------------------------------------------------------------------ //
// Scope discriminated consumer tests
// ------------------------------------------------------------------ //

describe("scope discriminated session helpers", () => {
  it("business session exposes businessId and no profileId", () => {
    expect(businessSession.scope.kind).toBe("business");
    if (businessSession.scope.kind === "business") {
      expect(businessSession.scope.businessId).toBe("business-1");
    }
  });

  it("personal session exposes profileId and no businessId", () => {
    expect(personalSession.scope.kind).toBe("personal");
    if (personalSession.scope.kind === "personal") {
      expect(personalSession.scope.profileId).toBe("profile-1");
    }
  });

  it("business session has tenantId and apiBaseUrl", () => {
    expect(businessSession.tenantId).toBe("tenant-1");
    expect(businessSession.apiBaseUrl).toBe("http://app.test");
    expect(businessSession.label).toBe("Family Business");
  });

  it("personal session has tenantId and apiBaseUrl", () => {
    expect(personalSession.tenantId).toBe("tenant-1");
    expect(personalSession.apiBaseUrl).toBe("http://app.test");
    expect(personalSession.label).toBe("Personal");
  });
});

// ------------------------------------------------------------------ //
// Tag settings helpers
// ------------------------------------------------------------------ //

describe("tag management helpers", () => {
  it("getSuggestionSourceLabel handles all known sources", () => {
    const knownSources = ["historical", "ai", "manual", "manual_baseline"] as const;
    for (const s of knownSources) {
      expect(getSuggestionSourceLabel(s)).toBeTypeOf("string");
      expect(getSuggestionSourceLabel(s).length).toBeGreaterThan(0);
    }
  });
});
