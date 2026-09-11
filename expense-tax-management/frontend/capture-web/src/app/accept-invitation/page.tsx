"use client";

import { useSignIn, useSignUp } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useEffectEvent, useRef, useState } from "react";

function InvitationAcceptance() {
  const searchParams = useSearchParams();
  const ticket = searchParams.get("__clerk_ticket");
  const status = searchParams.get("__clerk_status");
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const started = useRef(false);
  const signUpRef = useRef(signUp);
  const invitedEmailRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);

  useEffect(() => {
    signUpRef.current = signUp;
  }, [signUp]);

  const acceptInvitation = useEffectEvent(async () => {
    const navigateToCapture = ({ decorateUrl }: { decorateUrl: (url: string) => string }) => {
      window.location.assign(decorateUrl("/capture"));
    };

    const accept = async () => {
      if (status === "sign_in") {
        const result = await signIn.ticket({ ticket: ticket! });
        if (result.error) {
          setError(result.error.longMessage ?? result.error.message);
          return;
        }
        if (signIn.status !== "complete") {
          setError("Invitation sign-in needs another authentication step.");
          return;
        }
        const finalized = await signIn.finalize({ navigate: navigateToCapture });
        if (finalized.error) setError(finalized.error.longMessage ?? finalized.error.message);
        return;
      }

      const result = await signUp.ticket({ ticket: ticket! });
      if (result.error) {
        setError(result.error.longMessage ?? result.error.message);
        return;
      }
      if (signUp.status !== "complete") {
        invitedEmailRef.current = signUp.emailAddress;
        if (signUp.missingFields.includes("password")) {
          setNeedsPassword(true);
        } else {
          setError(`Invitation sign-up needs: ${signUp.missingFields.join(", ") || "additional details"}.`);
        }
        return;
      }
      const finalized = await signUp.finalize({ navigate: navigateToCapture });
      if (finalized.error) setError(finalized.error.longMessage ?? finalized.error.message);
    };

    await accept();
  });

  useEffect(() => {
    if (started.current || !ticket || (status !== "sign_in" && status !== "sign_up")) return;

    started.current = true;
    void acceptInvitation().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not accept invitation.");
    });
  }, [status, ticket]);

  const completePasswordSignUp = async () => {
    setError(null);
    try {
      const activeSignUp = signUpRef.current;
      if (!activeSignUp.emailAddress) {
        setError("Invitation did not include an email address.");
        return;
      }
      if (activeSignUp.emailAddress !== invitedEmailRef.current) {
        setError("Invitation account changed. Restart invitation link.");
        return;
      }

      const result = await activeSignUp.password({ password });
      if (result.error) {
        setError(result.error.longMessage ?? result.error.message);
        return;
      }
      const completedSignUp = signUpRef.current;
      if (completedSignUp.status !== "complete") {
        setError("Invitation sign-up is missing required account details.");
        return;
      }
      const finalized = await completedSignUp.finalize({
        navigate: ({ decorateUrl }) => window.location.assign(decorateUrl("/capture")),
      });
      if (finalized.error) setError(finalized.error.longMessage ?? finalized.error.message);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not finish invitation setup.");
    }
  };

  if (!ticket || (status !== "sign_in" && status !== "sign_up")) {
    return <main className="auth"><h1>Invalid invitation link</h1><p>Ask for a new invitation.</p></main>;
  }

  if (needsPassword) {
    return (
      <main className="auth">
        <h1>Create your account password</h1>
        <p>Invitation is locked to invited email address. Choose password to finish setup.</p>
        {error ? <p>{error}</p> : null}
        <form onSubmit={(event) => { event.preventDefault(); void completePasswordSignUp(); }}>
          <label htmlFor="invitation-password">Password</label>
          <input
            id="invitation-password"
            type="password"
            value={password}
            autoComplete="new-password"
            minLength={8}
            required
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit">Finish setup</button>
        </form>
      </main>
    );
  }

  if (error) {
    return <main className="auth"><h1>Invitation could not be accepted</h1><p>{error}</p></main>;
  }

  return <main className="auth"><h1>Accepting invitation</h1><p>Signing you in with invited email address...</p><div id="clerk-captcha" /></main>;
}

export default function AcceptInvitationPage() {
  return <Suspense fallback={<main className="auth"><h1>Loading invitation</h1></main>}><InvitationAcceptance /></Suspense>;
}
