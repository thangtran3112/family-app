export type ClerkGetToken = (options: {
  template: string;
  skipCache?: boolean;
}) => Promise<string | null>;

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
