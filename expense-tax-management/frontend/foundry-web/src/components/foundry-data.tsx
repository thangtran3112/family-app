"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { ClerkGetToken } from "@/lib/clerk";
import { readPlatformSession, type PlatformSession } from "@/lib/session";

type Loader<T> = (session: PlatformSession, getToken: ClerkGetToken) => Promise<T>;

export function FoundryData<T>({
  load,
  children,
}: {
  load: Loader<T>;
  children: (data: T) => ReactNode;
}) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const session = useMemo(() => (isLoaded && isSignedIn ? readPlatformSession() : null), [isLoaded, isSignedIn]);
  const [state, setState] = useState<{ data?: T; error?: string }>({});

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !session) return;
    let active = true;
    void load(session, getToken)
      .then((data) => {
        if (active) setState({ data });
      })
      .catch((error: unknown) => {
        if (active) setState({ error: error instanceof Error ? error.message : "Request failed" });
      });
    return () => {
      active = false;
    };
  }, [getToken, isLoaded, isSignedIn, load, session]);

  if (isLoaded && isSignedIn && !session) return <div className="empty" role="alert">Foundry session unavailable. Sign in again.</div>;
  if (state.error) return <div className="empty" role="alert">{state.error}</div>;
  if (state.data === undefined) return <div className="empty" aria-live="polite">Loading secure data...</div>;
  return children(state.data);
}
