const { randomUUID } = require("node:crypto");

const {
  MEMBER_ROLES,
  MEMBER_STATUSES,
  ORGANIZATION_TYPES,
  ORGANIZATION_STATUSES
} = require("./config");
const {
  cleanText,
  choice,
  normalizeEmail,
  uniqueValues,
  overlaps,
  formatDate,
  addHours
} = require("./utils");

function upsertRuntimeEntry(list, entry) {
  const index = list.findIndex((item) => item.id === entry.id);
  if (index >= 0) list[index] = entry;
  else list.unshift(entry);
}

function normalizeOrganizationPayload(body, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || body.id || `org-local-${randomUUID().slice(0, 8)}`,
    name: cleanText(body.name, existing.name || ""),
    type: choice(body.type || existing.type, ORGANIZATION_TYPES, "other"),
    status: choice(body.status || existing.status, ORGANIZATION_STATUSES, "active"),
    managerEmail: normalizeEmail(body.managerEmail || existing.managerEmail || ""),
    contactEmail: normalizeEmail(body.contactEmail || existing.contactEmail || ""),
    notes: cleanText(body.notes, existing.notes || ""),
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function normalizeMemberPayload(body, existing = {}, organizations = []) {
  const now = new Date().toISOString();
  const organizationId = cleanText(body.organizationId, existing.organizationId || "");
  const organization = organizations.find((entry) => entry.id === organizationId);
  return {
    id: existing.id || body.id || `member-local-${randomUUID().slice(0, 8)}`,
    erpUserId: cleanText(body.erpUserId, existing.erpUserId || ""),
    email: normalizeEmail(body.email || existing.email || ""),
    name: cleanText(body.name, existing.name || ""),
    role: choice(body.role || existing.role, MEMBER_ROLES, "applicant"),
    status: choice(body.status || existing.status, MEMBER_STATUSES, "pending"),
    organizationId,
    organization: organization?.name || cleanText(body.organization, existing.organization || "미지정"),
    phone: cleanText(body.phone, existing.phone || ""),
    memo: cleanText(body.memo, existing.memo || ""),
    lastLoginAt: body.lastLoginAt || existing.lastLoginAt || null,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function buildMemberSummary(seed) {
  const members = seed.members || [];
  const applicationsByEmail = new Map();
  for (const application of seed.applications || []) {
    const email = normalizeEmail(application.email);
    if (!email) continue;
    applicationsByEmail.set(email, (applicationsByEmail.get(email) || 0) + 1);
  }
  return {
    total: members.length,
    active: members.filter((member) => member.status === "active").length,
    pending: members.filter((member) => member.status === "pending").length,
    suspended: members.filter((member) => member.status === "suspended").length,
    admins: members.filter((member) => member.role === "admin").length,
    staff: members.filter((member) => member.role === "staff").length,
    organizations: (seed.organizations || []).length,
    applicationsByEmail: Object.fromEntries(applicationsByEmail)
  };
}

function addTimeline(application, type, actor, memo = "") {
  application.timeline = Array.isArray(application.timeline) ? application.timeline : [];
  application.timeline.unshift({
    type,
    actor: actor?.name || "시스템",
    role: actor?.role || "system",
    memo,
    at: new Date().toISOString()
  });
}

function addRuntimeEvent(runtime, type, actor, payload = {}) {
  runtime.events.unshift({
    id: `evt-${randomUUID().slice(0, 10)}`,
    type,
    actor: actor?.name || "시스템",
    role: actor?.role || "system",
    payload,
    createdAt: new Date().toISOString()
  });
  runtime.events = runtime.events.slice(0, 300);
}

function upsertRuntimeApplication(runtime, application) {
  const index = runtime.applications.findIndex((entry) => entry.id === application.id);
  if (index >= 0) runtime.applications[index] = application;
  else runtime.applications.unshift(application);
}

function findApplication(seed, applicationId) {
  return (seed.applications || []).find((application) => application.id === applicationId);
}

function findLoanByApplication(runtime, applicationId) {
  return runtime.loans.find((loan) => loan.applicationId === applicationId);
}

function makeReservationsForApplication(application, status, holdHours) {
  const expiresAt = status === "tentative"
    ? addHours(new Date(), holdHours).toISOString()
    : null;
  return application.items.map((item) => ({
    id: `res-local-${randomUUID().slice(0, 8)}`,
    applicationId: application.id,
    status,
    itemId: item.itemId,
    quantity: Number(item.quantity || item.requestedQuantity || 0),
    startDate: application.startDate,
    endDate: application.endDate,
    organization: application.organization,
    createdAt: new Date().toISOString(),
    expiresAt
  }));
}

function ensureRuntimeReservations(runtime, seed, application, status) {
  const existing = seed.reservations.filter((reservation) => reservation.applicationId === application.id);
  if (!existing.length) {
    runtime.reservations.push(...makeReservationsForApplication(
      application,
      status,
      runtime.settings.tentativeHoldHours
    ));
  } else {
    const runtimeReservationIds = new Set(runtime.reservations.map((reservation) => reservation.id));
    for (const reservation of existing) {
      if (!runtimeReservationIds.has(reservation.id)) {
        runtime.reservations.push({ ...reservation });
      }
    }
  }

  for (const reservation of runtime.reservations) {
    if (reservation.applicationId === application.id) {
      reservation.status = status;
      reservation.updatedAt = new Date().toISOString();
      if (status !== "tentative") reservation.expiresAt = null;
    }
  }
}

function buildLoan(application, actor) {
  return {
    id: `loan-local-${randomUUID().slice(0, 8)}`,
    applicationId: application.id,
    status: "active",
    organization: application.organization,
    checkedOutBy: actor.name,
    checkedOutAt: new Date().toISOString(),
    dueAt: `${application.endDate}T18:00:00+09:00`,
    items: application.items.map((item) => ({
      itemId: item.itemId,
      quantity: Number(item.quantity || item.requestedQuantity || 0),
      trackingMode: "quantity"
    }))
  };
}

// 반납 검수에서 파손/수리 수량이 나오면 후속 관리용 수리 티켓을 자동 생성한다.
function buildRepairTicket(inspection, actor) {
  const damaged = Number(inspection.damagedQuantity || 0);
  const repair = Number(inspection.repairQuantity || 0);
  const now = new Date().toISOString();
  return {
    id: `fix-${randomUUID().slice(0, 8)}`,
    inspectionId: inspection.id,
    applicationId: inspection.applicationId || null,
    itemId: inspection.itemId,
    quantity: damaged + repair,
    issueType: damaged > 0 && repair > 0 ? "mixed" : (damaged > 0 ? "damaged" : "repair"),
    status: "open",
    returnedToRentable: 0,
    note: inspection.note || "",
    createdBy: actor?.name || "시스템",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null
  };
}

function normalizeInventoryPayload(body, existing = {}) {
  const code = String(body.code || existing.code || "").trim().toUpperCase();
  const name = String(body.name || existing.name || "").trim();
  const category = String(body.category || existing.category || "미분류").trim();
  const totalQuantity = Number(body.totalQuantity ?? existing.totalQuantity ?? 0);
  const unavailableQuantity = Number(body.unavailableQuantity ?? existing.unavailableQuantity ?? 0);
  const rentableQuantity = Number(body.rentableQuantity ?? existing.rentableQuantity ?? Math.max(0, totalQuantity - unavailableQuantity));
  const unit = String(body.unit || existing.unit || "개").trim();
  const unitType = String(body.unitType || existing.unitType || "quantity").trim();
  const notes = String(body.notes ?? existing.notes ?? "").trim();
  const keywords = Array.isArray(body.keywords)
    ? body.keywords
    : String(body.keywords || existing.keywords || "")
      .split(/[,\n]/)
      .map((keyword) => keyword.trim())
      .filter(Boolean);

  return {
    ...existing,
    code,
    name,
    category,
    totalQuantity,
    unavailableQuantity,
    rentableQuantity,
    unit,
    unitType,
    rentable: body.rentable ?? existing.rentable ?? true,
    keywords: uniqueValues([name, code, ...keywords]),
    notes
  };
}

function buildStats(seed) {
  const applicationStatusCounts = {};
  for (const application of seed.applications || []) {
    applicationStatusCounts[application.status] = (applicationStatusCounts[application.status] || 0) + 1;
  }

  const categoryStats = seed.categories.map((category) => {
    const items = seed.inventory.filter((item) => item.category === category);
    return {
      category,
      itemCount: items.length,
      totalQuantity: items.reduce((sum, item) => sum + item.totalQuantity, 0),
      rentableQuantity: items.reduce((sum, item) => sum + item.rentableQuantity, 0),
      unavailableQuantity: items.reduce((sum, item) => sum + item.unavailableQuantity, 0)
    };
  });

  const today = formatDate(new Date());
  const overdue = (seed.applications || []).filter((application) =>
    application.status === "checked_out" && application.endDate < today
  );

  return {
    totals: {
      items: seed.inventory.length,
      totalQuantity: seed.inventory.reduce((sum, item) => sum + item.totalQuantity, 0),
      rentableQuantity: seed.inventory.reduce((sum, item) => sum + item.rentableQuantity, 0),
      unavailableQuantity: seed.inventory.reduce((sum, item) => sum + item.unavailableQuantity, 0),
      reservations: seed.reservations.filter((reservation) => ["tentative", "confirmed", "checked_out"].includes(reservation.status)).length,
      applications: seed.applications.length,
      loans: (seed.loans || []).length,
      returns: (seed.returnInspections || []).length,
      overdue: overdue.length
    },
    applicationStatusCounts,
    categoryStats,
    recentEvents: seed.events || []
  };
}

// 두 날짜 문자열(YYYY-MM-DD) 사이의 일수 (양 끝 포함)
function inclusiveDays(startDate, endDate) {
  const diff = (new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000;
  return Math.max(0, Math.round(diff)) + 1;
}

// 두 기간이 겹치는 일수 (양 끝 포함, 겹치지 않으면 0)
function overlapDays(startA, endA, startB, endB) {
  const start = startA > startB ? startA : startB;
  const end = endA < endB ? endA : endB;
  if (start > end) return 0;
  return inclusiveDays(start, end);
}

function inPeriod(dateText, startDate, endDate) {
  if (!dateText) return false;
  const day = String(dateText).slice(0, 10);
  return day >= startDate && day <= endDate;
}

// 기간별 운영 리포트: 대여 활동 / 사용률 / 파손·분실율 / 연체 / 수리 티켓
function buildPeriodReport(seed, startDate, endDate) {
  const periodDays = inclusiveDays(startDate, endDate);
  const itemById = new Map(seed.inventory.map((item) => [item.id, item]));

  // --- 대여 활동: 기간과 겹치는 신청(상태별) + 기간 내 반출 건수 ---
  const periodApplications = (seed.applications || []).filter((application) =>
    application.startDate && application.endDate &&
    overlaps(application.startDate, application.endDate, startDate, endDate)
  );
  const applicationsByStatus = {};
  for (const application of periodApplications) {
    applicationsByStatus[application.status] = (applicationsByStatus[application.status] || 0) + 1;
  }
  const checkouts = (seed.loans || []).filter((loan) => inPeriod(loan.checkedOutAt, startDate, endDate)).length;

  // --- 품목별 대여 횟수·수량 (반려/취소 제외 신청 기준) Top 10 ---
  const rentalByItem = new Map();
  for (const application of periodApplications) {
    if (["rejected", "canceled"].includes(application.status)) continue;
    for (const line of application.items || []) {
      const entry = rentalByItem.get(line.itemId) || { rentalCount: 0, rentalQuantity: 0 };
      entry.rentalCount += 1;
      entry.rentalQuantity += Number(line.quantity || line.requestedQuantity || 0);
      rentalByItem.set(line.itemId, entry);
    }
  }

  // --- 사용률: (기간 내 예약·대여 점유 일수 × 수량 합) / (대여 기준 수량 × 기간 일수) ---
  // 취소 예약은 제외, 반납 완료(returned)도 해당 기간에는 점유했으므로 포함한다.
  const occupiedByItem = new Map();
  for (const reservation of seed.reservations || []) {
    if (reservation.status === "canceled") continue;
    const days = overlapDays(reservation.startDate, reservation.endDate, startDate, endDate);
    if (days <= 0) continue;
    const occupied = days * Number(reservation.quantity || 0);
    occupiedByItem.set(reservation.itemId, (occupiedByItem.get(reservation.itemId) || 0) + occupied);
  }

  const utilizationFor = (item) => {
    const capacity = Number(item.rentableQuantity || 0) * periodDays;
    const occupied = occupiedByItem.get(item.id) || 0;
    return { capacity, occupied, rate: capacity > 0 ? occupied / capacity : 0 };
  };

  const topItems = [...rentalByItem.entries()]
    .map(([itemId, entry]) => {
      const item = itemById.get(itemId);
      const utilization = item ? utilizationFor(item) : { capacity: 0, occupied: 0, rate: 0 };
      return {
        itemId,
        code: item?.code || itemId,
        name: item?.name || itemId,
        unit: item?.unit || "",
        rentalCount: entry.rentalCount,
        rentalQuantity: entry.rentalQuantity,
        occupiedDayQuantity: utilization.occupied,
        utilizationRate: Number(utilization.rate.toFixed(4))
      };
    })
    .sort((a, b) => b.rentalCount - a.rentalCount || b.rentalQuantity - a.rentalQuantity)
    .slice(0, 10);

  const categoryUtilization = (seed.categories || []).map((category) => {
    const items = seed.inventory.filter((item) => item.category === category);
    let capacity = 0;
    let occupied = 0;
    for (const item of items) {
      const utilization = utilizationFor(item);
      capacity += utilization.capacity;
      occupied += utilization.occupied;
    }
    return {
      category,
      itemCount: items.length,
      capacityDayQuantity: capacity,
      occupiedDayQuantity: occupied,
      utilizationRate: Number((capacity > 0 ? occupied / capacity : 0).toFixed(4))
    };
  });

  // --- 파손/분실율: 기간 내 검수의 (damaged+repair+lost) 합 / checkedOut 합 ---
  const periodInspections = (seed.returnInspections || []).filter((inspection) =>
    inPeriod(inspection.inspectedAt, startDate, endDate)
  );
  const damageByItem = new Map();
  const damageTotal = { checkedOut: 0, damaged: 0, repair: 0, lost: 0, abnormal: 0, rate: 0 };
  for (const inspection of periodInspections) {
    const abnormal = Number(inspection.damagedQuantity || 0) +
      Number(inspection.repairQuantity || 0) +
      Number(inspection.lostQuantity || 0);
    const entry = damageByItem.get(inspection.itemId) || { checkedOut: 0, abnormal: 0 };
    entry.checkedOut += Number(inspection.checkedOutQuantity || 0);
    entry.abnormal += abnormal;
    damageByItem.set(inspection.itemId, entry);
    damageTotal.checkedOut += Number(inspection.checkedOutQuantity || 0);
    damageTotal.damaged += Number(inspection.damagedQuantity || 0);
    damageTotal.repair += Number(inspection.repairQuantity || 0);
    damageTotal.lost += Number(inspection.lostQuantity || 0);
    damageTotal.abnormal += abnormal;
  }
  damageTotal.rate = Number((damageTotal.checkedOut > 0 ? damageTotal.abnormal / damageTotal.checkedOut : 0).toFixed(4));

  // --- 연체: 기간 내 반납 기한(dueAt)이 지난 뒤 반납됐거나 아직 미반납인 반출 ---
  const nowIso = new Date().toISOString();
  let returnedLate = 0;
  let unreturned = 0;
  const currentOverdue = [];
  for (const loan of seed.loans || []) {
    if (!loan.dueAt) continue;
    const returnedAt = loan.returnedAt || loan.closedAt || null;
    if (inPeriod(loan.dueAt, startDate, endDate)) {
      if (returnedAt && returnedAt > loan.dueAt) returnedLate += 1;
      if (!returnedAt && nowIso > loan.dueAt) unreturned += 1;
    }
    // 현재 연체 중: 아직 반납되지 않았고 기한이 지난 반출 (기간과 무관하게 현황 표시)
    if (!returnedAt && loan.status === "active" && nowIso > loan.dueAt) {
      const overdueDaysCount = Math.max(1, Math.floor((new Date(nowIso) - new Date(loan.dueAt)) / 86400000));
      currentOverdue.push({
        loanId: loan.id,
        applicationId: loan.applicationId || null,
        organization: loan.organization || "미지정",
        dueAt: loan.dueAt,
        overdueDays: overdueDaysCount
      });
    }
  }
  currentOverdue.sort((a, b) => b.overdueDays - a.overdueDays);

  // --- 수리 티켓: 기간 내 생성/해결 수 + 현재 미해결(open/in_repair) 잔량 ---
  const repairTickets = seed.repairTickets || [];
  const repairs = {
    created: repairTickets.filter((ticket) => inPeriod(ticket.createdAt, startDate, endDate)).length,
    resolved: repairTickets.filter((ticket) => ticket.status === "resolved" && inPeriod(ticket.resolvedAt, startDate, endDate)).length,
    open: repairTickets.filter((ticket) => ["open", "in_repair"].includes(ticket.status)).length
  };

  return {
    period: { startDate, endDate, days: periodDays },
    totals: {
      applications: periodApplications.length,
      applicationsByStatus,
      checkouts,
      inspections: periodInspections.length,
      rentalItemKinds: rentalByItem.size
    },
    topItems,
    categoryUtilization,
    damage: {
      total: damageTotal,
      byItem: [...damageByItem.entries()].map(([itemId, entry]) => {
        const item = itemById.get(itemId);
        return {
          itemId,
          code: item?.code || itemId,
          name: item?.name || itemId,
          checkedOut: entry.checkedOut,
          abnormal: entry.abnormal,
          rate: Number((entry.checkedOut > 0 ? entry.abnormal / entry.checkedOut : 0).toFixed(4))
        };
      }).sort((a, b) => b.rate - a.rate)
    },
    overdue: {
      returnedLate,
      unreturned,
      current: currentOverdue
    },
    repairs
  };
}

function buildLabels(seed) {
  return seed.inventory.map((item) => ({
    id: `label-${item.id}`,
    itemId: item.id,
    code: item.code,
    name: item.name,
    text: `ATC-${item.code}`,
    qrValue: `atc-equipment:${item.id}:${item.code}`
  }));
}

function calculateAvailability(seed, itemId, startDate, endDate, options = {}) {
  const item = seed.inventory.find((entry) => entry.id === itemId || entry.code === itemId);
  if (!item) return null;

  const occupiedReservations = seed.reservations.filter((reservation) => {
    const relevantStatus = ["tentative", "confirmed", "checked_out"].includes(reservation.status);
    const excludedApplication = options.excludeApplicationId && reservation.applicationId === options.excludeApplicationId;
    return relevantStatus &&
      !excludedApplication &&
      reservation.itemId === item.id &&
      overlaps(reservation.startDate, reservation.endDate, startDate, endDate);
  });

  const occupiedQuantity = occupiedReservations.reduce((sum, reservation) => sum + reservation.quantity, 0);
  const availableQuantity = Math.max(0, item.rentableQuantity - occupiedQuantity);

  return {
    item,
    requestedStartDate: startDate,
    requestedEndDate: endDate,
    occupiedQuantity,
    availableQuantity,
    conflicts: occupiedReservations,
    formula: {
      totalQuantity: item.totalQuantity,
      unavailableQuantity: item.unavailableQuantity,
      rentableQuantity: item.rentableQuantity,
      occupiedQuantity
    }
  };
}

module.exports = {
  upsertRuntimeEntry,
  normalizeOrganizationPayload,
  normalizeMemberPayload,
  buildMemberSummary,
  addTimeline,
  addRuntimeEvent,
  upsertRuntimeApplication,
  findApplication,
  findLoanByApplication,
  makeReservationsForApplication,
  ensureRuntimeReservations,
  buildLoan,
  buildRepairTicket,
  normalizeInventoryPayload,
  buildStats,
  buildPeriodReport,
  buildLabels,
  calculateAvailability
};
