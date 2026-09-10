import type { JWTVerifyGetKey } from "jose";

export type AppTokenType = "tenant" | "service";

export interface AuthPrincipal {
  readonly tokenType: AppTokenType;
  readonly subject: string;
  readonly clientId: string | null;
  readonly audience: string;
  readonly issuer: string;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly tokenId: string;
  readonly email: string | null;
  readonly emailVerified: boolean | null;
  readonly displayName: string | null;
  readonly organizationId?: string;
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthPrincipal>;
}

export interface AuthVerifiers {
  readonly tenant: TokenVerifier;
  readonly service: TokenVerifier;
}

export type AuthKeyResolver = JWTVerifyGetKey;
