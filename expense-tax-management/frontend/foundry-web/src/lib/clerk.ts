export type ClerkGetToken = (options: {
  template: string;
  skipCache?: boolean;
}) => Promise<string | null>;

export function requireClerkPublishableKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key) throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required");
  return key;
}

export async function getPlatformAuthorization(
  getToken: ClerkGetToken,
  options: { skipCache?: boolean } = {},
) {
  const token = await getToken({
    template: "expense-foundry-platform",
    ...(options.skipCache ? { skipCache: true } : {}),
  });
  if (!token) throw new Error("Authentication required");
  return { authorization: `Bearer ${token}` };
}
