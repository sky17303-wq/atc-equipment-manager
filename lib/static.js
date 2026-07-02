const fs = require("node:fs/promises");
const path = require("node:path");

const { ROOT, PUBLIC_DIR, CONTENT_TYPES } = require("./config");
const { sendText } = require("./http-utils");

async function serveStatic(req, res, url) {
  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === "/") requestedPath = "/index.html";
  const rootDir = requestedPath.startsWith("/docs/") || requestedPath.startsWith("/database/")
    ? ROOT
    : PUBLIC_DIR;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(rootDir, safePath);

  if (!filePath.startsWith(rootDir)) {
    sendText(res, "Forbidden", 403);
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    const acceptsHtml = String(req.headers.accept || "").includes("text/html");
    const hasExtension = Boolean(path.extname(requestedPath));

    // SPA fallback: allow direct links such as /equipment/dashboard to load the app shell.
    if (req.method === "GET" && acceptsHtml && !hasExtension) {
      try {
        const indexPath = path.join(PUBLIC_DIR, "index.html");
        const content = await fs.readFile(indexPath);
        res.writeHead(200, {
          "Content-Type": CONTENT_TYPES[".html"] || "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end(content);
        return;
      } catch {
        // Fall through to the normal 404 if the app shell is unavailable.
      }
    }

    sendText(res, "Not found", 404);
  }
}

module.exports = { serveStatic };
