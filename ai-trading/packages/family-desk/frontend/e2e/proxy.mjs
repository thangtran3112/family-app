import { createServer, request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../static-server.mjs";

const E2E_EMAIL = "e2e@example.test";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function loopbackApiTarget(value) {
  const target = new URL(value);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error("E2E API target must be a loopback HTTP origin");
  }
  return target;
}

function hasE2ESession(req) {
  return (req.headers.cookie || "").split(";").some((part) => part.trim() === "desk_e2e_session=1");
}

function forwardedCookies(req) {
  const cookies = (req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && part !== "desk_e2e_session=1");
  return cookies.length ? cookies.join("; ") : undefined;
}

function requestHeaders(req) {
  const connectionTokens = new Set(
    (req.headers.connection || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (
      name === "host" ||
      name === "cookie" ||
      name === "authorization" ||
      HOP_BY_HOP.has(name) ||
      connectionTokens.has(name) ||
      /^(cf-access-|x-auth-request-|x-user-|x-principal-|x-identity|x-verified-|x-authenticated-|x-amzn-oidc-)/.test(name) ||
      /^(x-forwarded-(user|email|identity|client-cert)|x-original-authenticated-user|remote-user)$/.test(name)
    ) {
      continue;
    }
    headers[name] = value;
  }
  const cookie = forwardedCookies(req);
  if (cookie) headers.cookie = cookie;
  if (hasE2ESession(req)) headers["cf-access-authenticated-user-email"] = E2E_EMAIL;
  return headers;
}

function responseHeaders(headers) {
  const connectionTokens = new Set(
    (headers.connection || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name) && !connectionTokens.has(name)),
  );
}

export function createE2EServer({ root, apiTarget }) {
  const target = loopbackApiTarget(apiTarget);
  const staticServer = createStaticServer(root);

  return createServer((req, res) => {
    const pathname = new URL(req.url, "http://desk-e2e").pathname;
    if (pathname !== "/api" && !pathname.startsWith("/api/")) {
      staticServer.emit("request", req, res);
      return;
    }

    const upstream = httpRequest(
      {
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || 80,
        method: req.method,
        path: req.url,
        headers: requestHeaders(req),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end('{"detail":"test API unavailable"}');
      } else {
        res.destroy();
      }
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = process.env.DESK_E2E_STATIC_ROOT || fileURLToPath(new URL("../out/", import.meta.url));
  const apiTarget = process.env.DESK_E2E_API_ORIGIN || "http://127.0.0.1:18044";
  const port = Number(process.env.DESK_E2E_PROXY_PORT || 18045);
  const server = createE2EServer({ root, apiTarget });
  server.listen(port, "127.0.0.1", () => console.log(`Desk e2e proxy listening on 127.0.0.1:${port}`));
}
