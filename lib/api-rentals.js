const { randomUUID } = require("node:crypto");

const { isSsemEmail, normalizeDateInput } = require("./utils");
const { sendJson, readBody } = require("./http-utils");
const { saveRuntimeState } = require("./storage");
const { normalizeApplication, reservationStatusForApplication } = require("./state");
const { requireRole } = require("./auth");
const {
  addRuntimeEvent,
  addTimeline,
  buildLoan,
  calculateAvailability,
  ensureRuntimeReservations,
  findApplication,
  findLoanByApplication,
  makeReservationsForApplication,
  upsertRuntimeApplication
} = require("./domain");

// 대여 신청/상태 전이/반납 검수 API
async function handleRentalsApi(context) {
  const { req, res, url, seed, runtime, actor } = context;

  if (req.method === "POST" && url.pathname === "/api/applications") {
    const allowedActor = requireRole(actor, res, ["applicant", "staff", "admin"]);
    if (!allowedActor) return true;

    const body = await readBody(req);
    if (!body.draft || !Array.isArray(body.draft.items)) {
      sendJson(res, { error: "draft.items가 필요합니다." }, 400);
      return true;
    }

    // applicant는 본인 이메일로만 신청할 수 있다 (타인 명의 제출 방지).
    const email = allowedActor.role === "applicant"
      ? allowedActor.email
      : (body.draft.email || allowedActor.email);
    if (!isSsemEmail(email)) {
      sendJson(res, { error: "@ssem.re.kr 계정만 대여 신청을 제출할 수 있습니다." }, 403);
      return true;
    }

    const startDate = normalizeDateInput(body.draft.startDate);
    const endDate = normalizeDateInput(body.draft.endDate);
    if (!startDate || !endDate || startDate > endDate) {
      sendJson(res, { error: "신청 시작일과 종료일을 확인하세요." }, 400);
      return true;
    }

    const items = body.draft.items
      .map((item) => ({
        itemId: item.itemId,
        quantity: Number(item.requestedQuantity || item.quantity || 0)
      }))
      .filter((item) => item.itemId && item.quantity > 0);

    if (!items.length) {
      sendJson(res, { error: "신청 품목이 필요합니다." }, 400);
      return true;
    }

    for (const item of items) {
      const availability = calculateAvailability(seed, item.itemId, startDate, endDate);
      if (!availability || availability.availableQuantity < item.quantity) {
        sendJson(res, {
          error: "기간 내 대여 가능 수량이 부족합니다.",
          itemId: item.itemId,
          availableQuantity: availability?.availableQuantity || 0
        }, 409);
        return true;
      }
    }

    const application = {
      id: `app-local-${randomUUID().slice(0, 8)}`,
      status: "submitted",
      organization: body.draft.organization || "미입력",
      applicant: body.draft.applicant || "미입력",
      email,
      startDate,
      endDate,
      purpose: body.draft.purpose || "교구 대여",
      deliveryMethod: body.draft.deliveryMethod || "pickup",
      items,
      createdAt: new Date().toISOString()
    };
    addTimeline(application, "submitted", allowedActor, "신청 제출 및 24시간 임시 선점");
    runtime.applications.unshift(application);
    const reservations = makeReservationsForApplication(
      application,
      "tentative",
      runtime.settings.tentativeHoldHours
    );
    runtime.reservations.push(...reservations);
    addRuntimeEvent(runtime, "application.submitted", allowedActor, { applicationId: application.id });
    await saveRuntimeState(runtime);
    sendJson(res, { application, reservations }, 201);
    return true;
  }

  const applicationActionMatch = url.pathname.match(/^\/api\/applications\/([^/]+)\/(approve|reject|checkout|return)$/);
  if (req.method === "POST" && applicationActionMatch) {
    const [, rawApplicationId, action] = applicationActionMatch;
    const applicationId = decodeURIComponent(rawApplicationId);
    const allowedActor = requireRole(actor, res, ["staff", "admin"]);
    if (!allowedActor) return true;

    const body = await readBody(req);
    const application = findApplication(seed, applicationId);
    if (!application) {
      sendJson(res, { error: "신청을 찾을 수 없습니다." }, 404);
      return true;
    }

    const updated = normalizeApplication({ ...application });
    const reservations = seed.reservations.filter((reservation) => reservation.applicationId === updated.id);

    if (action === "approve") {
      if (!["submitted", "approved"].includes(updated.status)) {
        sendJson(res, { error: "승인 대기 상태의 신청만 승인할 수 있습니다." }, 409);
        return true;
      }

      for (const item of updated.items) {
        const availability = calculateAvailability(seed, item.itemId, updated.startDate, updated.endDate, {
          excludeApplicationId: updated.id
        });
        const quantity = Number(item.quantity || item.requestedQuantity || 0);
        if (!availability || availability.availableQuantity < quantity) {
          sendJson(res, {
            error: "승인할 수량이 부족합니다.",
            itemId: item.itemId,
            availableQuantity: availability?.availableQuantity || 0
          }, 409);
          return true;
        }
      }

      updated.status = "approved";
      updated.approvedAt = new Date().toISOString();
      updated.approvedBy = allowedActor.name;
      addTimeline(updated, "approved", allowedActor, body.memo || "담당자 승인");
      ensureRuntimeReservations(runtime, seed, updated, "confirmed");
      addRuntimeEvent(runtime, "application.approved", allowedActor, { applicationId: updated.id });
    }

    if (action === "reject") {
      if (["checked_out", "returned", "closed"].includes(updated.status)) {
        sendJson(res, { error: "이미 반출 이후 단계인 신청은 반려할 수 없습니다." }, 409);
        return true;
      }
      updated.status = "rejected";
      updated.rejectedAt = new Date().toISOString();
      updated.rejectedBy = allowedActor.name;
      updated.staffMemo = body.memo || updated.staffMemo || "담당자 반려";
      addTimeline(updated, "rejected", allowedActor, updated.staffMemo);
      ensureRuntimeReservations(runtime, seed, updated, "canceled");
      addRuntimeEvent(runtime, "application.rejected", allowedActor, { applicationId: updated.id });
    }

    if (action === "checkout") {
      if (updated.status !== "approved") {
        sendJson(res, { error: "승인 완료 상태만 반출할 수 있습니다." }, 409);
        return true;
      }
      updated.status = "checked_out";
      updated.checkedOutAt = new Date().toISOString();
      updated.checkedOutBy = allowedActor.name;
      addTimeline(updated, "checked_out", allowedActor, body.memo || "교구 반출 처리");
      ensureRuntimeReservations(runtime, seed, updated, "checked_out");
      let loan = findLoanByApplication(runtime, updated.id);
      if (!loan) {
        loan = buildLoan(updated, allowedActor);
        runtime.loans.unshift(loan);
      } else {
        loan.status = "active";
        loan.checkedOutAt = loan.checkedOutAt || new Date().toISOString();
      }
      addRuntimeEvent(runtime, "application.checked_out", allowedActor, { applicationId: updated.id, loanId: loan.id });
    }

    if (action === "return") {
      if (updated.status !== "checked_out") {
        sendJson(res, { error: "반출 상태만 반납 접수할 수 있습니다." }, 409);
        return true;
      }
      updated.status = "returned";
      updated.returnedAt = new Date().toISOString();
      updated.returnedBy = allowedActor.name;
      addTimeline(updated, "returned", allowedActor, body.memo || "반납 접수, 검수 대기");
      ensureRuntimeReservations(runtime, seed, updated, "returned");
      const loan = findLoanByApplication(runtime, updated.id);
      if (loan) {
        loan.status = "returned_pending_inspection";
        loan.returnedAt = new Date().toISOString();
      }
      addRuntimeEvent(runtime, "application.returned", allowedActor, { applicationId: updated.id, loanId: loan?.id });
    }

    upsertRuntimeApplication(runtime, updated);

    for (const reservation of runtime.reservations) {
      if (reservation.applicationId !== updated.id) continue;
      reservation.status = reservationStatusForApplication(updated, reservation.status);
      reservation.updatedAt = new Date().toISOString();
    }

    await saveRuntimeState(runtime);
    sendJson(res, {
      application: updated,
      reservations,
      loans: runtime.loans
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/returns/inspect") {
    const allowedActor = requireRole(actor, res, ["staff", "admin"]);
    if (!allowedActor) return true;

    const body = await readBody(req);
    const item = seed.inventory.find((entry) => entry.id === body.itemId || entry.code === body.itemId);
    if (!item) {
      sendJson(res, { error: "품목을 찾을 수 없습니다." }, 400);
      return true;
    }

    const checkedOutQuantity = Number(body.checkedOutQuantity || 0);
    const normalQuantity = Number(body.normalQuantity || 0);
    const damagedQuantity = Number(body.damagedQuantity || 0);
    const repairQuantity = Number(body.repairQuantity || 0);
    const lostQuantity = Number(body.lostQuantity || 0);
    const totalInspected = normalQuantity + damagedQuantity + repairQuantity + lostQuantity;

    if (checkedOutQuantity <= 0 || totalInspected !== checkedOutQuantity) {
      sendJson(res, { error: "반출 수량과 검수 수량 합계가 같아야 합니다." }, 400);
      return true;
    }

    const inspection = {
      id: `ret-local-${randomUUID().slice(0, 8)}`,
      status: "completed",
      organization: body.organization || "미입력",
      applicationId: body.applicationId || null,
      loanId: body.loanId || null,
      itemId: item.id,
      checkedOutQuantity,
      normalQuantity,
      damagedQuantity,
      repairQuantity,
      lostQuantity,
      inspectedBy: body.inspectedBy || allowedActor.name,
      inspectedAt: new Date().toISOString(),
      note: body.note || "",
      trackingMode: "quantity"
    };
    runtime.returnInspections.unshift(inspection);

    if (body.applicationId) {
      const application = findApplication(seed, body.applicationId);
      if (application) {
        const updated = normalizeApplication({ ...application, status: "closed", closedAt: new Date().toISOString() });
        addTimeline(updated, "inspected", allowedActor, body.note || "반납 검수 완료");
        upsertRuntimeApplication(runtime, updated);
      }
    }

    if (body.loanId) {
      const loan = runtime.loans.find((entry) => entry.id === body.loanId);
      if (loan) {
        loan.status = "closed";
        loan.closedAt = new Date().toISOString();
      }
    }

    addRuntimeEvent(runtime, "return.inspected", allowedActor, {
      inspectionId: inspection.id,
      itemId: item.id,
      abnormalQuantity: damagedQuantity + repairQuantity + lostQuantity
    });
    await saveRuntimeState(runtime);

    sendJson(res, {
      inspection,
      inventoryImpact: {
        itemId: item.id,
        itemName: item.name,
        returnedToRentableQuantity: normalQuantity,
        movedToUnavailableQuantity: damagedQuantity + repairQuantity + lostQuantity,
        reason: "번호 없는 교구 수량형 반납 검수"
      }
    }, 201);
    return true;
  }

  return false;
}

module.exports = { handleRentalsApi };
