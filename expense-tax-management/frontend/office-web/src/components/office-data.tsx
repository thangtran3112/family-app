"use client";

import { useAuth, useOrganization } from "@clerk/nextjs";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { ClerkGetToken } from "@/lib/clerk";
import { readOfficeSession, type OfficeSession } from "@/lib/session";

type Loader<T> = (
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string,
) => Promise<T>;

export function OfficeData<T>({
  load,
  children,
}: {
  load: Loader<T>;
  children: (data: T) => ReactNode;
}) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const session = useMemo(() => (isLoaded && isSignedIn ? readOfficeSession() : null), [isLoaded, isSignedIn]);
  const [state, setState] = useState<{ data?: T; error?: string }>({});

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !organizationLoaded || !session || !organization) return;
    let active = true;
    void load(session, getToken, organization.id)
      .then((data) => {
        if (active) setState({ data });
      })
      .catch((error: unknown) => {
        if (active) setState({ error: error instanceof Error ? error.message : "Request failed" });
      });
    return () => {
      active = false;
    };
  }, [getToken, isLoaded, isSignedIn, load, organization, organizationLoaded, session]);

  if (isLoaded && isSignedIn && !session) return <div className="empty" role="alert">Office session unavailable. Sign in again.</div>;
  if (isLoaded && isSignedIn && organizationLoaded && !organization) return <div className="empty" role="alert">Active organization required.</div>;
  if (state.error) return <div className="empty" role="alert">{state.error}</div>;
  if (state.data === undefined) return <div className="empty" aria-live="polite">Loading secure data...</div>;
  return children(state.data);
}
