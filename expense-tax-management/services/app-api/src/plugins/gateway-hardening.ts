import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  authorizationRateKey,
  classifyGatewayRoute,
  createGatewayRateLimiter,
} from "@expense-tax/gateway-policy";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cache-Control": "no-store",
} as const;

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

export function registerGatewayHardening(app: FastifyInstance): void {
  const limiter = createGatewayRateLimiter();

  app.addHook("onRequest", async (request, reply) => {
    const decision = limiter.check(
      classifyGatewayRoute(requestPath(request)),
      authorizationRateKey({
        ...(request.socket.remoteAddress
          ? { remoteAddress: request.socket.remoteAddress }
          : {}),
      }),
    );

    if (!decision.allowed) {
      return reply
        .header("Retry-After", decision.retryAfterSeconds)
        .code(429)
        .send({
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests",
            requestId: request.id,
          },
        });
    }
  });

  app.addHook("onSend", async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
  });
}
