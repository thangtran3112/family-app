"use client";

import { OrganizationSwitcher, SignIn, useAuth, useOrganization } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { getTenantGateState } from "@/lib/clerk";

export function OfficeAuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();

  const state = getTenantGateState({ isLoaded: isLoaded && organizationLoaded, isSignedIn, organizationId: organization?.id });
  if (state === "loading") {
    return <main className="auth"><p>Loading secure workspace...</p></main>;
  }
  if (state === "signed-out") {
    return <main className="auth"><SignIn routing="path" path="/login" /></main>;
  }
  if (state === "missing-organization") {
    return <main className="auth"><h1>Select an organization</h1><p>Choose active organization before accessing Office.</p><OrganizationSwitcher afterSelectOrganizationUrl="/dashboard" /></main>;
  }
  return children;
}
