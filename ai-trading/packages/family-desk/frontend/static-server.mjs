// Serves the pre-built `out/` directory. No framework, stdlib only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("./out/", import.meta.url).pathname);
const PORT = Number(process.env.PORT || 3000);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/x-component",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function resolveObjectPath(pathname) {
  if (pathname === "/") return "index.html";
  const clean = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (/\.[A-Za-z0-9]+$/.test(clean)) return clean;
  return `${clean}.html`;
}

function cacheControlFor(objectPath) {
  if (objectPath.startsWith("_next/static/")) return "public, max-age=31536000, immutable";
  return "no-store";
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

// Use path.relative rather than string-prefix matching so sibling paths cannot escape the root.
export function resolveUnderRoot(root, objectPath) {
  const full = resolve(root, objectPath);
  const rel = relative(root, full);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path escapes root");
  return full;
}

async function readUnderRoot(root, objectPath) {
  return readFile(resolveUnderRoot(root, objectPath));
}

export function createStaticServer(root = ROOT) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://static-server");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const objectPath = resolveObjectPath(url.pathname);
    let body;
    let status = 200;
    let servedPath = objectPath;
    try {
      body = await readUnderRoot(root, objectPath);
    } catch {
      try {
        body = await readUnderRoot(root, "404.html");
        status = 404;
        servedPath = "404.html";
      } catch {
        res.writeHead(404).end();
        return;
      }
    }
    const headers = {
      ...SECURITY_HEADERS,
      "content-type": CONTENT_TYPES[extname(servedPath)] || "application/octet-stream",
      "cache-control": cacheControlFor(servedPath),
    };
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createStaticServer().listen(PORT, () => {
    console.log(`static-server listening on ${PORT}`);
  });
}
