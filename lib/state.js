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

  seed.applications = applications;
  seed.reservations = reservations;
  seed.returnInspections = returnInspections;
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
