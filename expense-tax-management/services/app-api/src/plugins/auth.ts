import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AuthPrincipal,
  AuthVerifiers,
  TokenVerifier,
} from "../auth/types.js";
import {
  type IdentityResolver,
  verifiedIdentityFromPrincipal,
  type AuthenticatedUserContext,
  type VerifiedIdentity,
} from "../domain/authenticated-user.js";
import type { ClerkIdentityMappingDomain } from "../domain/clerk-identity.js";
import { DomainError } from "../errors.js";

declare module "fastify" {
  interface FastifyInstance {
    authVerifiers: AuthVerifiers;
    clerkIdentityDomain: ClerkIdentityMappingDomain | null;
  }

  interface FastifyRequest {
    authPrincipal: AuthPrincipal | null;
    authenticatedUser: AuthenticatedUserContext | null;
    verifiedIdentity: VerifiedIdentity | null;
    resolvedTenantId: string | null;
  }
}

export interface AuthPluginOptions {
  readonly authVerifiers: AuthVerifiers;
  readonly clerkIdentityDomain?: ClerkIdentityMappingDomain;
}

type AuthGuard = (request: FastifyRequest) => Promise<void>;

function requestError(statusCode: 401 | 403): DomainError {
  return statusCode === 401
    ? DomainError.unauthenticated()
    : DomainError.forbidden();
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    throw requestError(401);
  }

  const match = /^Bearer ([^\s,]+)$/i.exec(authorization);
  if (!match?.[1]) {
    throw requestError(401);
  }

  return match[1];
}

async function verifyRequest(
  request: FastifyRequest,
  verifier: TokenVerifier,
): Promise<AuthPrincipal> {
  try {
    return await verifier.verify(bearerToken(request));
  } catch {
    throw requestError(401);
  }
}

export function registerAuthPlugin(
  app: FastifyInstance,
  options: AuthPluginOptions,
): void {
  app.decorate("authVerifiers", options.authVerifiers);
  app.decorate("clerkIdentityDomain", options.clerkIdentityDomain ?? null);
  app.decorateRequest("authPrincipal", null);
  app.decorateRequest("authenticatedUser", null);
  app.decorateRequest("verifiedIdentity", null);
  app.decorateRequest("resolvedTenantId", null);
}

export const tenantGuard: AuthGuard = async (request) => {
  const principal = await verifyRequest(
    request,
    request.server.authVerifiers.tenant,
  );
  request.authPrincipal = principal;
  request.verifiedIdentity = verifiedIdentityFromPrincipal(principal);
  if (principal.organizationId !== undefined) {
    const mapping = request.server.clerkIdentityDomain;
    if (!mapping) throw requestError(401);
    const resolved = await mapping.resolveTenantIdentity(
      principal.subject,
      principal.organizationId,
    );
    if (resolved.status !== "resolved") throw requestError(401);
    request.resolvedTenantId = resolved.tenantId;
    request.authenticatedUser = {
      id: resolved.userId,
      primaryEmail: request.verifiedIdentity.verifiedEmail,
      displayName: request.verifiedIdentity.displayName,
      status: "active",
    };
  }
};

export function authenticatedUserGuard(identityResolver: IdentityResolver): AuthGuard {
  return async (request) => {
    const requestedTenantId =
      typeof request.params === "object" &&
      request.params !== null &&
      "tenantId" in request.params &&
      typeof request.params.tenantId === "string"
        ? request.params.tenantId
        : null;
    if (
      request.resolvedTenantId !== null &&
      requestedTenantId !== null &&
      request.resolvedTenantId !== requestedTenantId
    ) {
      throw requestError(403);
    }
    if (request.authenticatedUser !== null) return;
    const identity = request.verifiedIdentity;
    if (identity === null) {
      throw DomainError.unauthenticated();
    }

    const user = await identityResolver.resolve(identity.issuer, identity.subject);
    if (user === null) {
      throw DomainError.unauthenticated();
    }
    if (user.status !== "active") {
      throw DomainError.forbidden();
    }

    request.authenticatedUser = user;
  };
}

export function serviceGuard(
  expectedSubject: string,
  requiredScopes: readonly string[],
): AuthGuard {
  return async (request) => {
    const principal = await verifyRequest(
      request,
      request.server.authVerifiers.service,
    );
    const scopes = new Set(principal.scopes);

    if (
      principal.subject !== expectedSubject ||
      requiredScopes.some((scope) => !scopes.has(scope))
    ) {
      throw requestError(403);
    }

    request.authPrincipal = principal;
  };
}
