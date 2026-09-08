import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppAuthConfig } from "../config.js";
import type {
  AppTokenType,
  AuthKeyResolver,
  AuthPrincipal,
  AuthVerifiers,
  TokenVerifier,
} from "./types.js";

const REQUIRED_CLAIMS = ["sub", "jti", "iat", "exp"] as const;
const CLOCK_TOLERANCE_SECONDS = 30;

export interface CreateTokenVerifierOptions {
  readonly tokenType: AppTokenType;
  readonly issuer: string;
  readonly audience: string;
  readonly keyResolver: AuthKeyResolver;
}

function requiredNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid token claim");
  }

  return value;
}

function requiredNumericDate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Invalid token claim");
  }

  return value;
}

function parseStringArray(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error("Invalid token claim");
  }

  return value;
}

function parseScopes(value: unknown): readonly string[] {
  if (value === undefined || value === "") {
    return [];
  }
  if (typeof value !== "string") {
    throw new Error("Invalid token claim");
  }

  return value.split(" ").filter((scope) => scope.length > 0);
}

export function createTokenVerifier(
  options: CreateTokenVerifierOptions,
): TokenVerifier {
  return {
    async verify(token: string): Promise<AuthPrincipal> {
      try {
        const { payload } = await jwtVerify(token, options.keyResolver, {
          algorithms: ["RS256"],
          audience: options.audience,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          issuer: options.issuer,
          requiredClaims: [...REQUIRED_CLAIMS],
        });

        if (payload.aud !== options.audience) {
          throw new Error("Invalid token claim");
        }

        const subject = requiredNonEmptyString(payload.sub);
        const tokenId = requiredNonEmptyString(payload.jti);
        requiredNumericDate(payload.iat);
        requiredNumericDate(payload.exp);
        if (payload.nbf !== undefined) {
          requiredNumericDate(payload.nbf);
        }

        const clientId =
          payload.client_id === undefined
            ? null
            : requiredNonEmptyString(payload.client_id);
        if (options.tokenType === "service" && clientId === null) {
          throw new Error("Invalid token claim");
        }

        return {
          tokenType: options.tokenType,
          subject,
          clientId,
          audience: options.audience,
          issuer: options.issuer,
          roles: parseStringArray(payload.roles),
          scopes: parseScopes(payload.scope),
          tokenId,
        };
      } catch {
        throw new Error("Token verification failed");
      }
    },
  };
}

export function createRemoteAuthVerifiers(
  config: AppAuthConfig,
): AuthVerifiers {
  return {
    tenant: createTokenVerifier({
      tokenType: "tenant",
      issuer: config.tenant.issuer,
      audience: config.tenant.audience,
      keyResolver: createRemoteJWKSet(new URL(config.tenant.jwksUrl)),
    }),
    service: createTokenVerifier({
      tokenType: "service",
      issuer: config.service.issuer,
      audience: config.service.audience,
      keyResolver: createRemoteJWKSet(new URL(config.service.jwksUrl)),
    }),
  };
}
