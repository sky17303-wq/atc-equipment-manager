const { sendJson, readBody } = require("./http-utils");
const { saveRuntimeState } = require("./storage");
const { requireRole } = require("./auth");
const { addRuntimeEvent, upsertRuntimeEntry } = require("./domain");

// 수리 티켓 상태 전이 규칙: open → in_repair → resolved | scrapped
const REPAIR_TRANSITIONS = {
  open: ["in_repair"],
  in_repair: ["resolved", "scrapped"],
  resolved: [],
  scrapped: []
};

// 수리 티켓 조회/상태 전이 API
async function handleRepairsApi(context) {
  const { req, res, url, seed, runtime, actor } = context;

  if (req.method === "GET" && url.pathname === "/api/repairs") {
    const allowedActor = requireRole(actor, res, ["staff", "admin", "auditor"]);
    if (!allowedActor) return true;
    sendJson(res, { repairTickets: seed.repairTickets || [] });
    return true;
  }

  const statusMatch = url.pathname.match(/^\/api\/repairs\/([^/]+)\/status$/);
  if (req.method === "POST" && statusMatch) {
    const allowedActor = requireRole(actor, res, ["staff", "admin"]);
    if (!allowedActor) return true;

    const ticketId = decodeURIComponent(statusMatch[1]);
    const body = await readBody(req);
    const existing = (seed.repairTickets || []).find((entry) => entry.id === ticketId);
    if (!existing) {
      sendJson(res, { error: "수리 티켓을 찾을 수 없습니다." }, 404);
      return true;
    }

    const nextStatus = String(body.status || "");
    const allowedNext = REPAIR_TRANSITIONS[existing.status] || [];
    if (!allowedNext.includes(nextStatus)) {
      sendJson(res, {
        error: `${existing.status} 상태에서 ${nextStatus || "미지정"} 상태로 전이할 수 없습니다. (open → in_repair → resolved/scrapped)`
      }, 409);
      return true;
    }

    const ticket = { ...existing, status: nextStatus, updatedAt: new Date().toISOString() };
    if (body.note) ticket.note = String(body.note);

    if (nextStatus === "resolved") {
      const returnedToRentable = Number(body.returnedToRentable);
      if (!Number.isFinite(returnedToRentable) || returnedToRentable < 0 || returnedToRentable > Number(ticket.quantity || 0)) {
        sendJson(res, { error: "returnedToRentable은 0 이상, 티켓 수량 이하의 숫자여야 합니다." }, 400);
        return true;
      }
      // 실제 재고 가감(unavailable 차감, rentable 가산)은 lib/state.js buildEffectiveSeed가
      // resolved 티켓의 returnedToRentable을 근거로 검수 차감분을 상쇄하는 방식으로 계산한다.
      // (검수 이상 수량이 매 요청 rentable에서 자동 차감되므로 여기서 직접 override하면 이중 계산)
      ticket.returnedToRentable = returnedToRentable;
      ticket.resolvedAt = new Date().toISOString();
    }

    if (nextStatus === "scrapped") {
      // 폐기: 재고로 복귀하는 수량 없음. 검수 차감 상태(unavailable)가 그대로 유지된다.
      ticket.returnedToRentable = 0;
      ticket.resolvedAt = new Date().toISOString();
    }

    upsertRuntimeEntry(runtime.repairTickets, ticket);
    addRuntimeEvent(runtime, "repair.status_changed", allowedActor, {
      repairTicketId: ticket.id,
      itemId: ticket.itemId,
      status: ticket.status,
      returnedToRentable: ticket.returnedToRentable
    });
    await saveRuntimeState(runtime);
    sendJson(res, { repairTicket: ticket });
    return true;
  }

  return false;
}

module.exports = { handleRepairsApi };
