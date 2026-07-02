const { DEFAULT_SETTINGS, DEFAULT_ORGANIZATIONS, DEFAULT_MEMBERS } = require("./config");
const { mergeById, uniqueValues } = require("./utils");
const { getSeed, getRuntimeState } = require("./storage");

function normalizeApplication(application) {
  return {
    timeline: [],
    deliveryMethod: "pickup",
    ...application,
    items: Array.isArray(application.items) ? application.items : []
  };
}

function reservationStatusForApplication(application, fallbackStatus) {
  if (!application) return fallbackStatus;
  return {
    draft: "tentative",
    submitted: "tentative",
    approved: "confirmed",
    checked_out: "checked_out",
    returned: "returned",
    closed: "returned",
    rejected: "canceled",
    canceled: "canceled"
  }[application.status] || fallbackStatus;
}

function linkReservationsToApplications(reservations, applications) {
  for (const reservation of reservations) {
    if (reservation.applicationId) continue;
    const match = applications.find((application) =>
      application.organization === reservation.organization &&
      application.startDate === reservation.startDate &&
      application.endDate === reservation.endDate &&
      application.items.some((item) =>
        item.itemId === reservation.itemId &&
        Number(item.quantity || item.requestedQuantity || 0) === Number(reservation.quantity || 0)
      )
    );
    if (match) reservation.applicationId = match.id;
  }
}

function applyRuntimeInventory(seed, runtime) {
  const inventoryMap = new Map(seed.inventory.map((item) => [item.id, { ...item }]));

  for (const item of runtime.inventoryItems) {
    if (!item?.id) continue;
    inventoryMap.set(item.id, { ...item });
  }

  for (const [itemId, override] of Object.entries(runtime.inventoryOverrides || {})) {
    const existing = inventoryMap.get(itemId);
    if (!existing) continue;
    inventoryMap.set(itemId, { ...existing, ...override, id: itemId });
  }

  seed.inventory = [...inventoryMap.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  seed.categories = uniqueValues([
    ...(seed.categories || []),
    ...seed.inventory.map((item) => item.category)
  ]);
}

function buildEffectiveSeed(seed, runtime) {
  applyRuntimeInventory(seed, runtime);

  const runtimeApplicationIds = new Set(runtime.applications.map((application) => application.id));
  const applications = [
    ...runtime.applications.map(normalizeApplication),
    ...(seed.applications || [])
      .filter((application) => !runtimeApplicationIds.has(application.id))
      .map(normalizeApplication)
  ].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  const reservations = [
    ...(seed.reservations || []).map((reservation) => ({ ...reservation })),
    ...runtime.reservations.map((reservation) => ({ ...reservation }))
  ];
  linkReservationsToApplications(reservations, applications);

  const applicationsById = new Map(applications.map((application) => [application.id, application]));
  for (const reservation of reservations) {
    reservation.status = reservationStatusForApplication(
      applicationsById.get(reservation.applicationId),
      reservation.status
    );
  }

  const returnInspections = mergeById([
    ...runtime.returnInspections,
    ...(seed.returnInspections || [])
  ]);

  for (const inspection of returnInspections) {
    const item = seed.inventory.find((entry) => entry.id === inspection.itemId);
    if (!item) continue;
    const abnormalQuantity = Number(inspection.damagedQuantity || 0) +
      Number(inspection.repairQuantity || 0) +
      Number(inspection.lostQuantity || 0);
    item.unavailableQuantity += abnormalQuantity;
    item.rentableQuantity = Math.max(0, item.rentableQuantity - abnormalQuantity);
  }

  const repairTickets = mergeById([
    ...(runtime.repairTickets || []),
    ...(seed.repairTickets || [])
  ]).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  // 수리 티켓 재고 복귀 상쇄:
  // 위 검수 차감 루프가 모든 검수 기록의 damaged/repair/lost 수량을 매 요청마다
  // rentable에서 빼고 unavailable에 더한다(검수 기록은 불변). 따라서 resolved 티켓의
  // returnedToRentable을 inventoryOverrides로 반영하면 검수 차감과 이중 계산된다.
  // 대신 여기서 resolved 티켓의 복귀 수량만큼 해당 검수 차감 효과를 되돌려
  // "수리 완료 후 재고 복귀"를 파생 상태로 일관되게 표현한다.
  for (const ticket of repairTickets) {
    if (ticket.status !== "resolved") continue;
    const restored = Number(ticket.returnedToRentable || 0);
    if (restored <= 0) continue;
    const item = seed.inventory.find((entry) => entry.id === ticket.itemId);
    if (!item) continue;
    item.unavailableQuantity = Math.max(0, item.unavailableQuantity - restored);
    item.rentableQuantity += restored;
  }

  seed.applications = applications;
  seed.reservations = reservations;
  seed.returnInspections = returnInspections;
  seed.repairTickets = repairTickets;
  seed.loans = mergeById([
    ...runtime.loans,
    ...(seed.loans || [])
  ]);
  seed.events = mergeById([
    ...runtime.events,
    ...(seed.events || [])
  ]).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  seed.organizations = mergeById([
    ...(DEFAULT_ORGANIZATIONS || []),
    ...(seed.organizations || []),
    ...runtime.organizations
  ]).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  const organizationById = new Map(seed.organizations.map((organization) => [organization.id, organization]));
  seed.members = mergeById([
    ...(DEFAULT_MEMBERS || []),
    ...(seed.members || []),
    ...runtime.members
  ])
    .map((member) => {
      const organization = organizationById.get(member.organizationId);
      return {
        ...member,
        organization: organization?.name || member.organization || "미지정"
      };
    })
    .sort((a, b) => String(a.name || a.email || "").localeCompare(String(b.name || b.email || "")));
  seed.settings = { ...DEFAULT_SETTINGS, ...(seed.settings || {}), ...(runtime.settings || {}) };
  return seed;
}

async function getSystemState() {
  const seed = JSON.parse(JSON.stringify(await getSeed()));
  const runtime = await getRuntimeState();
  return { seed: buildEffectiveSeed(seed, runtime), runtime };
}

async function getEffectiveSeed() {
  const { seed } = await getSystemState();
  return seed;
}

module.exports = {
  normalizeApplication,
  reservationStatusForApplication,
  linkReservationsToApplications,
  applyRuntimeInventory,
  buildEffectiveSeed,
  getSystemState,
  getEffectiveSeed
};
