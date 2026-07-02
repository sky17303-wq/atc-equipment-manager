const http = require("node:http");

const { PORT, HOST, BASE_PATH, loadEnv } = require("./lib/config");
const { sendJson, stripBasePath } = require("./lib/http-utils");
const { postgresEnabled } = require("./lib/storage-postgres");
const { calculateAvailability } = require("./lib/domain");
const { localParse, buildAiResponse } = require("./lib/ai-parser");
const { parseInventoryCsv } = require("./lib/utils");
const { handleApi } = require("./lib/api");
const { serveStatic } = require("./lib/static");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    const basePathResult = stripBasePath(url);
    if (basePathResult.redirect) {
      res.writeHead(302, { Location: `${BASE_PATH}/` });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, { error: "Not found" }, 404);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

if (require.main === module) {
  server.listen(PORT, HOST || undefined, () => {
    console.log(`ATC equipment manager running at http://${HOST || "localhost"}:${PORT}`);
  });
}

module.exports = {
  server,
  loadEnv,
  BASE_PATH,
  calculateAvailability,
  localParse,
  buildAiResponse,
  parseInventoryCsv,
  postgresEnabled
};
