"use client";

import { SignIn, useAuth } from "@clerk/nextjs";
import type { ReactNode } from "react";

export function FoundryAuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return <main className="login"><p>Loading secure platform…</p></main>;
  if (!isSignedIn) return <main className="login"><SignIn routing="hash" /></main>;
  return children;
}
