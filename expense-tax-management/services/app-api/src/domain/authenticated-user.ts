import type { AuthPrincipal } from "../auth/types.js";
import { DomainError } from "../errors.js";

export interface AuthenticatedUserContext {
  readonly id: string;
  readonly primaryEmail: string;
  readonly displayName: string;
  readonly status: "active" | "disabled";
}

export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly verifiedEmail: string;
  readonly displayName: string;
  readonly tokenId: string;
}

export interface IdentityResolver {
  resolve(issuer: string, subject: string): Promise<AuthenticatedUserContext | null>;
}

export function verifiedIdentityFromPrincipal(
  principal: AuthPrincipal,
): VerifiedIdentity {
  if (
    principal.tokenType !== "tenant" ||
    principal.email === null ||
    principal.emailVerified !== true ||
    principal.displayName === null
  ) {
    throw DomainError.unauthenticated();
  }

  return {
    issuer: principal.issuer,
    subject: principal.subject,
    verifiedEmail: principal.email.trim().toLowerCase(),
    displayName: principal.displayName.trim(),
    tokenId: principal.tokenId,
  };
}
