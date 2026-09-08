import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AuthPrincipal,
  AuthVerifiers,
  TokenVerifier,
} from "../auth/types.js";

declare module "fastify" {
  interface FastifyInstance {
    authVerifiers: AuthVerifiers;
  }

  interface FastifyRequest {
    authPrincipal: AuthPrincipal | null;
  }
}

export interface AuthPluginOptions {
  readonly authVerifiers: AuthVerifiers;
}

type AuthGuard = (request: FastifyRequest) => Promise<void>;

function requestError(statusCode: 401 | 403): Error & { statusCode: number } {
  return Object.assign(new Error("Authentication failed"), { statusCode });
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
  app.decorateRequest("authPrincipal", null);
}

export function platformGuard(requiredRole: string): AuthGuard {
  return async (request) => {
    const principal = await verifyRequest(
      request,
      request.server.authVerifiers.platform,
    );

    if (!principal.roles.includes(requiredRole)) {
      throw requestError(403);
    }

    request.authPrincipal = principal;
  };
}

export function serviceGuard(
  allowedPrincipal: string,
  requiredScopes: readonly string[],
): AuthGuard {
  return async (request) => {
    const principal = await verifyRequest(
      request,
      request.server.authVerifiers.service,
    );
    const scopes = new Set(principal.scopes);

    if (
      principal.clientId !== allowedPrincipal ||
      requiredScopes.some((scope) => !scopes.has(scope))
    ) {
      throw requestError(403);
    }

    request.authPrincipal = principal;
  };
}
