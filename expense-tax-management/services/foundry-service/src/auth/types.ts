import type { JWTVerifyGetKey } from "jose";

export type FoundryTokenType = "platform" | "service";

export interface AuthPrincipal {
  readonly tokenType: FoundryTokenType;
  readonly subject: string;
  readonly clientId: string | null;
  readonly audience: string;
  readonly issuer: string;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly tokenId: string;
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthPrincipal>;
}

export interface AuthVerifiers {
  readonly platform: TokenVerifier;
  readonly service: TokenVerifier;
}

export type AuthKeyResolver = JWTVerifyGetKey;
