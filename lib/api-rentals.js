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
  buildRepairTicket,
  calculateAvailability,
  ensureRuntimeReservations,
  findApplication,
  findLoanByApplication,
  makeReservationsForApplication,
  upsertRuntimeApplication
} = require("./domain");
const { enqueueNotification, formatItemsSummary } = require("./notifications");

// 신청자에게 보낼 상태 전이 알림의 공통 꼬리말
const NOTIFICATION_FOOTER = "\n문의: 컴퓨팅교사협회 교구 운영 담당";

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
      // 신청자에게 승인 알림 (기간·품목 요약 포함)
      enqueueNotification(runtime, {
        type: "application.approved",
        recipient: updated.email,
        subject: "[ATC 교구] 교구 대여 신청이 승인되었습니다",
        body: [
          `${updated.applicant || "선생님"}님, 교구 대여 신청이 승인되었습니다.`,
          "",
          `기관: ${updated.organization || "미입력"}`,
          `기간: ${updated.startDate} ~ ${updated.endDate}`,
          `품목: ${formatItemsSummary(seed, updated.items)}`,
          NOTIFICATION_FOOTER
        ].join("\n"),
        relatedId: updated.id
      });
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
      // 신청자에게 반려 알림 (사유 포함)
      enqueueNotification(runtime, {
        type: "application.rejected",
        recipient: updated.email,
        subject: "[ATC 교구] 교구 대여 신청이 반려되었습니다",
        body: [
          `${updated.applicant || "선생님"}님, 교구 대여 신청이 반려되었습니다.`,
          "",
          `기관: ${updated.organization || "미입력"}`,
          `기간: ${updated.startDate} ~ ${updated.endDate}`,
          `사유: ${updated.staffMemo || "담당자 반려"}`,
          NOTIFICATION_FOOTER
        ].join("\n"),
        relatedId: updated.id
      });
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
      // 신청자에게 반출 완료 알림 (반납 예정일 포함)
      enqueueNotification(runtime, {
        type: "application.checked_out",
        recipient: updated.email,
        subject: "[ATC 교구] 교구 반출이 완료되었습니다",
        body: [
          `${updated.applicant || "선생님"}님, 신청하신 교구가 반출되었습니다.`,
          "",
          `기관: ${updated.organization || "미입력"}`,
          `품목: ${formatItemsSummary(seed, updated.items)}`,
          `반납 예정일: ${String(loan.dueAt || "").slice(0, 10) || updated.endDate}`,
          NOTIFICATION_FOOTER
        ].join("\n"),
        relatedId: updated.id
      });
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
      // 신청자에게 반납 접수 알림
      enqueueNotification(runtime, {
        type: "application.returned",
        recipient: updated.email,
        subject: "[ATC 교구] 반납이 접수되었습니다",
        body: [
          `${updated.applicant || "선생님"}님, 교구 반납이 접수되었습니다. 검수 후 결과를 안내드립니다.`,
          "",
          `기관: ${updated.organization || "미입력"}`,
          `품목: ${formatItemsSummary(seed, updated.items)}`,
          NOTIFICATION_FOOTER
        ].join("\n"),
        relatedId: updated.id
      });
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

    // 신청 연동 검수: 품목별 부분 검수를 지원한다.
    // applicationId가 없는 독립 검수(수량형 임시 검수)는 기존 동작을 유지한다.
    let application = null;
    if (body.applicationId) {
      application = findApplication(seed, body.applicationId);
      if (!application) {
        sendJson(res, { error: "신청을 찾을 수 없습니다." }, 404);
        return true;
      }
      if (application.status !== "returned") {
        sendJson(res, { error: "반납 접수(returned) 상태의 신청만 품목 검수를 기록할 수 있습니다." }, 409);
        return true;
      }
      const targetItem = (application.items || []).find((entry) => entry.itemId === item.id);
      if (!targetItem) {
        sendJson(res, { error: "신청에 포함되지 않은 품목입니다.", itemId: item.id }, 400);
        return true;
      }
      const requiredQuantity = Number(targetItem.quantity || targetItem.requestedQuantity || 0);
      if (checkedOutQuantity !== requiredQuantity) {
        sendJson(res, {
          error: "검수 반출 수량이 신청 품목 수량과 일치해야 합니다.",
          itemId: item.id,
          requiredQuantity
        }, 400);
        return true;
      }
      // seed.returnInspections는 runtime+DB(seed) 병합본이라 두 드라이버 모두에서
      // 이미 검수된 품목을 판별할 수 있다. 같은 품목 중복 검수는 거부한다.
      const alreadyInspected = (seed.returnInspections || []).some((entry) =>
        entry.applicationId === application.id && entry.itemId === item.id
      );
      if (alreadyInspected) {
        sendJson(res, { error: "이미 검수된 품목입니다.", itemId: item.id }, 409);
        return true;
      }
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

    // 파손/수리 수량이 있으면 후속 관리용 수리 티켓을 자동 생성한다.
    let repairTicket = null;
    if (damagedQuantity + repairQuantity > 0) {
      repairTicket = buildRepairTicket(inspection, allowedActor);
      runtime.repairTickets.unshift(repairTicket);
      addRuntimeEvent(runtime, "repair.opened", allowedActor, {
        repairTicketId: repairTicket.id,
        inspectionId: inspection.id,
        itemId: item.id,
        quantity: repairTicket.quantity
      });
    }

    // 다품목 신청은 모든 품목의 검수가 끝났을 때만 closed로 전환한다.
    let updatedApplication = null;
    let applicationProgress = null;
    if (application) {
      const inspectedItemIds = new Set(
        (seed.returnInspections || [])
          .filter((entry) => entry.applicationId === application.id)
          .map((entry) => entry.itemId)
      );
      inspectedItemIds.add(item.id);
      const pendingItemIds = (application.items || [])
        .map((entry) => entry.itemId)
        .filter((itemId) => !inspectedItemIds.has(itemId));
      const completed = pendingItemIds.length === 0;
      applicationProgress = { completed, pendingItemIds };

      if (completed) {
        updatedApplication = normalizeApplication({ ...application, status: "closed", closedAt: new Date().toISOString() });
        addTimeline(updatedApplication, "inspected", allowedActor, body.note || "전 품목 반납 검수 완료");
        // 전 품목 완료 시에만 반출(loan)도 함께 종결한다.
        let loan = findLoanByApplication(runtime, application.id) ||
          runtime.loans.find((entry) => entry.id === body.loanId);
        if (!loan) {
          const seedLoan = (seed.loans || []).find((entry) => entry.applicationId === application.id);
          if (seedLoan) {
            loan = { ...seedLoan };
            runtime.loans.unshift(loan);
          }
        }
        if (loan) {
          loan.status = "closed";
          loan.closedAt = new Date().toISOString();
        }
        // 신청자에게 검수 완료(종결) 알림: 전 품목의 정상/파손/수리/분실 합계 요약
        const applicationInspections = [
          ...(seed.returnInspections || []).filter((entry) => entry.applicationId === application.id),
          inspection
        ];
        const sums = applicationInspections.reduce((acc, entry) => ({
          normal: acc.normal + Number(entry.normalQuantity || 0),
          damaged: acc.damaged + Number(entry.damagedQuantity || 0),
          repair: acc.repair + Number(entry.repairQuantity || 0),
          lost: acc.lost + Number(entry.lostQuantity || 0)
        }), { normal: 0, damaged: 0, repair: 0, lost: 0 });
        enqueueNotification(runtime, {
          type: "application.closed",
          recipient: application.email,
          subject: "[ATC 교구] 반납 검수가 완료되었습니다",
          body: [
            `${application.applicant || "선생님"}님, 반납 검수가 완료되어 신청이 종결되었습니다.`,
            "",
            `기관: ${application.organization || "미입력"}`,
            `품목: ${formatItemsSummary(seed, application.items)}`,
            `검수 결과: 정상 ${sums.normal} · 파손 ${sums.damaged} · 수리 ${sums.repair} · 분실 ${sums.lost}`,
            NOTIFICATION_FOOTER
          ].join("\n"),
          relatedId: application.id
        });
      } else {
        // 일부 품목만 검수됨: 신청은 returned 유지, 타임라인에 부분 검수 기록만 남긴다.
        updatedApplication = normalizeApplication({ ...application });
        addTimeline(updatedApplication, "inspected", allowedActor,
          `부분 검수: ${item.name} 완료, 잔여 ${pendingItemIds.length}개 품목 대기`);
      }
      upsertRuntimeApplication(runtime, updatedApplication);
    } else if (body.loanId) {
      // 독립 검수(기존 verify 흐름): loanId만 온 경우 기존 동작대로 즉시 종결한다.
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
      application: updatedApplication || undefined,
      applicationProgress: applicationProgress || undefined,
      repairTicket: repairTicket || undefined,
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
