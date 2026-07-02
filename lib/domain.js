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
  normalizeInventoryPayload,
  buildStats,
  buildLabels,
  calculateAvailability
};
