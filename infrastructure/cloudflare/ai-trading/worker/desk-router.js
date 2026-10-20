// Public, data-free Desk shell; Caddy/Clerk remains the API trust boundary.
export function resolveStaticObjectKey(pathname) {
  if (pathname === "/") return "index.html";
  const clean = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return /\.[A-Za-z0-9]+$/.test(clean) ? clean : `${clean}.html`;
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function withHeaders(response, status = response.status, api = false) {
  const headers = new Headers(response.headers);
  for (const name of ["x-goog-hash", "x-goog-stored-content-length", "x-goog-storage-class", "x-guploader-uploadid"]) headers.delete(name);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (api) headers.set("cache-control", "no-store");
  // Reuse the body stream: never buffer SSE (or large static assets).
  return new Response(response.body, { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/desk/")) {
      const origin = new Request(`https://${env.ORIGIN_HOSTNAME}${url.pathname}${url.search}`, request);
      const response = await fetch(origin, { cache: "no-store", redirect: "manual" });
      return withHeaders(response, response.status, true);
    }
    // Unknown APIs must never fall through to the public bucket.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return withHeaders(new Response("Not Found", { status: 404 }), 404, true);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withHeaders(new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } }));
    }
    const key = resolveStaticObjectKey(url.pathname);
    const base = `https://storage.googleapis.com/${env.STATIC_BUCKET}`;
    const response = await fetch(`${base}/${key}`, { method: request.method });
    if (response.status === 404 && key !== "404.html") {
      const fallback = await fetch(`${base}/404.html`, { method: request.method });
      return withHeaders(fallback, 404);
    }
    return withHeaders(response);
  },
};
