export type ClerkGetToken = (options: {
  template: string;
  organizationId?: string;
  skipCache?: boolean;
}) => Promise<string | null>;

export function getTenantGateState(input: {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  organizationId: string | null | undefined;
}) {
  if (!input.isLoaded) return "loading" as const;
  if (!input.isSignedIn) return "signed-out" as const;
  if (!input.organizationId) return "missing-organization" as const;
  return "ready" as const;
}

export async function getAppAuthorization(
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  options: { skipCache?: boolean } = {},
) {
  if (!organizationId) throw new Error("Active organization required");
  const token = await getToken({
    template: "expense-app",
    organizationId,
    ...(options.skipCache ? { skipCache: true } : {}),
  });
  if (!token) throw new Error("Authentication required");
  return { authorization: `Bearer ${token}` };
}
