import { createRemoteJWKSet, jwtVerify } from "jose";
import type {
  ClerkConfig,
  FoundryAuthConfig,
  FoundryConfig,
  TokenAuthorityConfig,
} from "../config.js";
import type {
  AuthKeyResolver,
  AuthPrincipal,
  AuthVerifiers,
  FoundryTokenType,
  TokenVerifier,
} from "./types.js";

const REQUIRED_CLAIMS = ["sub", "iat", "exp"] as const;
const CLOCK_TOLERANCE_SECONDS = 30;

export interface CreateTokenVerifierOptions {
  readonly tokenType: FoundryTokenType;
  readonly issuer: string;
  readonly audience: string;
  readonly keyResolver: AuthKeyResolver;
}

export type AuthKeyResolverFactory = (
  authority: TokenAuthorityConfig,
) => AuthKeyResolver;

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

function parseRoles(value: unknown, required: boolean): readonly string[] {
  if (value === undefined && !required) {
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

function clerkRole(payload: Record<string, unknown>): string | undefined {
  if (payload.platform_role !== undefined) {
    if (typeof payload.platform_role !== "string") {
      throw new Error("Invalid token claim");
    }
    return payload.platform_role;
  }
  return undefined;
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

function hasExpectedAudience(
  value: unknown,
  expected: string,
  allowSingletonArray: boolean,
): boolean {
  return (
    value === expected ||
    (allowSingletonArray &&
      Array.isArray(value) &&
      value.length === 1 &&
      value[0] === expected)
  );
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

        if (
          !hasExpectedAudience(
            payload.aud,
            options.audience,
            options.tokenType === "service",
          )
        ) {
          throw new Error("Invalid token claim");
        }

        const subject = requiredNonEmptyString(payload.sub);
        const tokenId = requiredNonEmptyString(
          payload.jti === undefined ? payload.sid : payload.jti,
        );
        const issuedAt = requiredNumericDate(payload.iat);
        requiredNumericDate(payload.exp);
        if (
          issuedAt >
          Math.floor(Date.now() / 1_000) + CLOCK_TOLERANCE_SECONDS
        ) {
          throw new Error("Invalid token claim");
        }
        if (payload.nbf !== undefined) {
          requiredNumericDate(payload.nbf);
        }

        // Service authorization is anchored to Clerk's signed machine subject.
        // client_id and azp are caller-controlled metadata, not identity.
        const clientId = options.tokenType === "service" ? subject : null;

        return {
          tokenType: options.tokenType,
          subject,
          clientId,
          audience: options.audience,
          issuer: options.issuer,
          roles: parseRoles(
            payload.roles === undefined
              ? (() => {
                  const role = clerkRole(payload);
                  return role === undefined ? undefined : [role];
                })()
              : payload.roles,
            options.tokenType === "platform",
          ),
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
  config: FoundryAuthConfig,
  keyResolverFactory: AuthKeyResolverFactory = (authority) =>
    createRemoteJWKSet(new URL(authority.jwksUrl)),
): AuthVerifiers {
  return {
    platform: createTokenVerifier({
      tokenType: "platform",
      issuer: config.platform.issuer,
      audience: config.platform.audience,
      keyResolver: keyResolverFactory(config.platform),
    }),
    service: createTokenVerifier({
      tokenType: "service",
      issuer: config.service.issuer,
      audience: config.service.audience,
      keyResolver: keyResolverFactory(config.service),
    }),
  };
}

export function createClerkAuthVerifiers(
  config: ClerkConfig,
  keyResolverFactory?: AuthKeyResolverFactory,
): AuthVerifiers {
  return createRemoteAuthVerifiers(
    {
      platform: {
        issuer: config.issuerUrl,
        audience: config.platformAudience,
        jwksUrl: config.jwksUrl,
      },
      service: {
        issuer: config.issuerUrl,
        audience: config.foundryServiceAudience,
        jwksUrl: config.jwksUrl,
      },
    },
    keyResolverFactory,
  );
}

export function createConfiguredAuthVerifiers(
  config: Pick<FoundryConfig, "authProvider" | "auth" | "clerk">,
  keyResolverFactory?: AuthKeyResolverFactory,
): AuthVerifiers {
  if (config.authProvider === "clerk") {
    if (config.clerk === undefined) {
      throw new Error(
        "Clerk auth configuration is required when AUTH_PROVIDER=clerk",
      );
    }
    return createClerkAuthVerifiers(config.clerk, keyResolverFactory);
  }

  return createRemoteAuthVerifiers(config.auth, keyResolverFactory);
}
