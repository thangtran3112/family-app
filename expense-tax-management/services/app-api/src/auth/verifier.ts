import { createRemoteJWKSet, jwtVerify } from "jose";
import type {
  AppAuthConfig,
  AppConfig,
  ClerkConfig,
  TokenAuthorityConfig,
} from "../config.js";
import type {
  AppTokenType,
  AuthKeyResolver,
  AuthPrincipal,
  AuthVerifiers,
  TokenVerifier,
} from "./types.js";

const REQUIRED_CLAIMS = ["sub", "iat", "exp"] as const;
const CLOCK_TOLERANCE_SECONDS = 30;

export interface CreateTokenVerifierOptions {
  readonly tokenType: AppTokenType;
  readonly issuer: string;
  readonly audience: string;
  readonly keyResolver: AuthKeyResolver;
  readonly requireVerifiedEmail?: boolean;
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

function clerkOrganizationId(payload: Record<string, unknown>): string | null {
  const nested = payload.o;
  const nestedId =
    typeof nested === "object" && nested !== null && "id" in nested
      ? nested.id
      : undefined;
  const values = [payload.org_id, nestedId].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (values.length > 1 && values[0] !== values[1]) {
    throw new Error("Invalid token claim");
  }
  if (payload.org_id !== undefined && values.length === 0) {
    throw new Error("Invalid token claim");
  }
  return values[0] ?? null;
}

function tenantIdentityClaims(
  tokenType: AppTokenType,
  payload: Record<string, unknown>,
  requireVerifiedEmail: boolean,
): Pick<AuthPrincipal, "displayName" | "email" | "emailVerified"> {
  if (tokenType === "service") {
    return { displayName: null, email: null, emailVerified: null };
  }

  const hasEmailClaims =
    payload.email !== undefined || payload.email_verified !== undefined;
  if (!requireVerifiedEmail && !hasEmailClaims) {
    return {
      displayName:
        payload.display_name === undefined
          ? null
          : requiredNonEmptyString(payload.display_name),
      email: null,
      emailVerified: null,
    };
  }

  if (payload.email_verified !== true) {
    throw new Error("Invalid token claim");
  }

  if (!requireVerifiedEmail) {
    return {
      displayName:
        payload.display_name === undefined
          ? null
          : requiredNonEmptyString(payload.display_name),
      email: requiredNonEmptyString(payload.email),
      emailVerified: true,
    };
  }

  return {
    displayName: requiredNonEmptyString(payload.display_name),
    email: requiredNonEmptyString(payload.email),
    emailVerified: true,
  };
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

        const organizationId =
          options.tokenType === "tenant" ? clerkOrganizationId(payload) : null;
        return {
          tokenType: options.tokenType,
          subject,
          clientId,
          audience: options.audience,
          issuer: options.issuer,
          roles: parseStringArray(payload.roles),
          scopes: parseScopes(payload.scope),
          tokenId,
          ...tenantIdentityClaims(
            options.tokenType,
            payload,
            options.requireVerifiedEmail ?? false,
          ),
          ...(organizationId === null ? {} : { organizationId }),
        };
      } catch {
        throw new Error("Token verification failed");
      }
    },
  };
}

export function createRemoteAuthVerifiers(
  config: AppAuthConfig,
  keyResolverFactory: AuthKeyResolverFactory = (authority) =>
    createRemoteJWKSet(new URL(authority.jwksUrl)),
): AuthVerifiers {
  return {
    tenant: createTokenVerifier({
      tokenType: "tenant",
      issuer: config.tenant.issuer,
      audience: config.tenant.audience,
      keyResolver: keyResolverFactory(config.tenant),
      requireVerifiedEmail: true,
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
      tenant: {
        issuer: config.issuerUrl,
        audience: config.tenantAudience,
        jwksUrl: config.jwksUrl,
      },
      service: {
        issuer: config.issuerUrl,
         audience: config.appServiceAudience,
        jwksUrl: config.jwksUrl,
      },
    },
    keyResolverFactory,
  );
}

export function createConfiguredAuthVerifiers(
  config: Pick<AppConfig, "authProvider" | "auth" | "clerk">,
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
