const { GEMINI_MODEL, ROLE_USERS, SUPABASE_URL, SUPABASE_ANON_KEY, ERP_SESSION_SECRET } = require("./config");
const { normalizeDateInput } = require("./utils");
const { sendJson, readBody } = require("./http-utils");
const { postgresEnabled } = require("./storage-postgres");
const { getSystemState } = require("./state");
const {
  authMode,
  erpPermissionSyncEnabled,
  getActor,
  loginUrl
} = require("./auth");
const { buildLabels, buildStats, calculateAvailability } = require("./domain");
const { buildAiResponse, localParse, parseWithGemini } = require("./ai-parser");
const { handleMembersApi } = require("./api-members");
const { handleRentalsApi } = require("./api-rentals");
const { handleInventoryApi } = require("./api-inventory");

async function handleApi(req, res, url) {
  const { seed, runtime } = await getSystemState();
  const actor = await getActor(req, seed, runtime);
  const context = { req, res, url, seed, runtime, actor };

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, {
      ok: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      model: GEMINI_MODEL,
      storageMode: postgresEnabled() ? "postgres" : "runtime-json",
      authMode: authMode(),
      supabaseAuthConfigured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
      erpSessionAuthConfigured: Boolean(ERP_SESSION_SECRET),
      erpPermissionSyncConfigured: erpPermissionSyncEnabled(),
      currentUser: actor
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    sendJson(res, {
      authenticated: actor.authenticated,
      authMode: authMode(),
      authSource: actor.authSource,
      loginUrl: loginUrl(),
      user: actor.authenticated ? actor : null,
      roles: Object.values(ROLE_USERS),
      policy: seed.settings
    });
    return true;
  }

  if (await handleMembersApi(context)) return true;

  if (req.method === "GET" && url.pathname === "/api/inventory") {
    sendJson(res, {
      categories: seed.categories,
      inventory: seed.inventory,
      reservations: seed.reservations,
      returnInspections: seed.returnInspections || []
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/returns") {
    sendJson(res, { returnInspections: seed.returnInspections || [] });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/applications") {
    sendJson(res, {
      applications: seed.applications,
      loans: seed.loans || []
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    sendJson(res, buildStats(seed));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/labels") {
    const limit = Math.max(1, Number(url.searchParams.get("limit") || 200));
    sendJson(res, { labels: buildLabels(seed).slice(0, limit) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/availability") {
    const body = await readBody(req);
    const startDate = normalizeDateInput(body.startDate);
    const endDate = normalizeDateInput(body.endDate);
    if (!body.itemId || !startDate || !endDate) {
      sendJson(res, { error: "itemId, startDate, endDate가 필요합니다." }, 400);
      return true;
    }
    sendJson(res, calculateAvailability(seed, body.itemId, startDate, endDate, {
      excludeApplicationId: body.excludeApplicationId
    }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ai/request") {
    const body = await readBody(req);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
      sendJson(res, { error: "프롬프트를 입력하세요." }, 400);
      return true;
    }

    try {
      const parsed = await parseWithGemini(seed, prompt, body.startDate, body.endDate) ||
        localParse(seed, prompt, body.startDate, body.endDate);
      sendJson(res, buildAiResponse(seed, parsed, prompt));
    } catch (error) {
      const parsed = localParse(seed, prompt, body.startDate, body.endDate);
      const response = buildAiResponse(seed, parsed, prompt);
      response.mode = "local-fallback";
      response.warning = error.message;
      sendJson(res, response);
    }
    return true;
  }

  if (await handleRentalsApi(context)) return true;

  if (await handleInventoryApi(context)) return true;

  return false;
}

module.exports = { handleApi };
