const HUB_LOGIN_URL = "https://trading-hub.tobytran.dev/login";

export function hubLoginUrl(returnTo: string): string {
  return `${HUB_LOGIN_URL}?returnTo=${encodeURIComponent(returnTo)}`;
}
