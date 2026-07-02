const { GEMINI_MODEL, ROLE_USERS, SUPABASE_URL, SUPABASE_ANON_KEY, ERP_SESSION_SECRET } = require("./config");
const { normalizeDateInput } = require("./utils");
const { sendJson, readBody } = require("./http-utils");
const { postgresEnabled } = require("./storage-postgres");
const { getSystemState } = require("./state");
const {
  authMode,
  erpPermissionSyncEnabled,
  getActor,
  loginUrl,
  requireAuthenticated
} = require("./auth");
const { normalizeEmail } = require("./utils");
const { buildLabels, buildStats, calculateAvailability } = require("./domain");
const { buildAiResponse, localParse, parseWithGemini } = require("./ai-parser");
const { handleMembersApi } = require("./api-members");
const { handleRentalsApi } = require("./api-rentals");
const { handleInventoryApi } = require("./api-inventory");

// 운영진(전체 조회 가능) 여부. applicant는 본인 데이터만 조회한다.
function isOperator(actor) {
  return ["staff", "admin", "auditor"].includes(actor.role);
}

function ownApplicationIds(seed, actor) {
  const email = normalizeEmail(actor.email);
  return new Set(
    (seed.applications || [])
      .filter((application) => normalizeEmail(application.email) === email)
      .map((application) => application.id)
  );
}

function scopeApplications(seed, actor) {
  if (isOperator(actor)) {
    return { applications: seed.applications, loans: seed.loans || [] };
  }
  const ownIds = ownApplicationIds(seed, actor);
  return {
    applications: (seed.applications || []).filter((application) => ownIds.has(application.id)),
    loans: (seed.loans || []).filter((loan) => ownIds.has(loan.applicationId))
  };
}

function scopeReturnInspections(seed, actor) {
  const inspections = seed.returnInspections || [];
  if (isOperator(actor)) return inspections;
  const ownIds = ownApplicationIds(seed, actor);
  return inspections.filter((inspection) => inspection.applicationId && ownIds.has(inspection.applicationId));
}

// applicant에게는 다른 기관 예약의 기관명/신청 ID를 가린다 (가용 수량 판단용 기간·수량은 유지).
function scopeReservations(seed, actor) {
  const reservations = seed.reservations || [];
  if (isOperator(actor)) return reservations;
  const ownIds = ownApplicationIds(seed, actor);
  return reservations.map((reservation) => {
    if (reservation.applicationId && ownIds.has(reservation.applicationId)) return reservation;
    return { ...reservation, organization: "다른 기관 예약", applicationId: null };
  });
}

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
    if (!requireAuthenticated(actor, res)) return true;
    sendJson(res, {
      categories: seed.categories,
      inventory: seed.inventory,
      reservations: scopeReservations(seed, actor),
      returnInspections: scopeReturnInspections(seed, actor)
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/returns") {
    if (!requireAuthenticated(actor, res)) return true;
    sendJson(res, { returnInspections: scopeReturnInspections(seed, actor) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/applications") {
    if (!requireAuthenticated(actor, res)) return true;
    sendJson(res, scopeApplications(seed, actor));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    if (!requireAuthenticated(actor, res)) return true;
    sendJson(res, buildStats(seed));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/labels") {
    if (!requireAuthenticated(actor, res)) return true;
    const limit = Math.max(1, Number(url.searchParams.get("limit") || 200));
    sendJson(res, { labels: buildLabels(seed).slice(0, limit) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/availability") {
    if (!requireAuthenticated(actor, res)) return true;
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
    if (!requireAuthenticated(actor, res)) return true;
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
