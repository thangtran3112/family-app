import type { DeskStatus } from "../api/schemas.ts";

// Settings copy for the IBKR gateway row (02l §c3). The Record type makes a new gateway state a type error until it has copy.
const GATEWAY_COPY: Record<DeskStatus["gateway"], string> = {
  not_configured: "Live IBKR quotes: not turned on · using delayed quotes",
  down: "Live IBKR quotes: waiting for IBKR sign-in · using delayed quotes",
  reconnecting: "Live IBKR quotes: reconnecting… · using delayed quotes",
  connected: "Live IBKR quotes: connected",
};

export function gatewayLine(state: DeskStatus["gateway"]): string {
  return GATEWAY_COPY[state];
}
