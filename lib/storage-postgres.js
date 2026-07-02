const { DEFAULT_SETTINGS } = require("./config");
const { dateOnly, isoDateTime, parseJsonValue, uniqueValues } = require("./utils");
const {
  upsertPostgresInventory,
  upsertPostgresApplication,
  upsertPostgresReservation,
  upsertPostgresLoan,
  upsertPostgresReturnInspection,
  upsertPostgresRepairTicket,
  upsertPostgresOrganization,
  upsertPostgresMember,
  upsertPostgresNotification,
  upsertPostgresEvent
} = require("./storage-postgres-upserts");

let pgPool = null;

function postgresEnabled() {
  return process.env.STORAGE_DRIVER === "postgres" ||
    Boolean(process.env.DATABASE_URL || process.env.PGHOST || process.env.PGDATABASE);
}

function buildPgConfig() {
  const ssl = String(process.env.PGSSL || "").toLowerCase();
  return {
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.PGHOST || undefined,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    database: process.env.PGDATABASE || undefined,
    user: process.env.PGUSER || undefined,
    password: process.env.PGPASSWORD || undefined,
    ssl: ssl === "true" || ssl === "1" ? { rejectUnauthorized: false } : undefined
  };
}

function getPgPool() {
  if (!pgPool) {
    let Pool;
    try {
      ({ Pool } = require("pg"));
    } catch {
      throw new Error("PostgreSQL 사용을 위해 `npm install` 또는 `npm.cmd install`로 pg 패키지를 설치하세요.");
    }
    pgPool = new Pool(buildPgConfig());
  }
  return pgPool;
}

async function getPostgresSeed() {
  const pool = getPgPool();
  const [
    settingsResult,
    inventoryResult,
    applicationsResult,
    applicationItemsResult,
    reservationsResult,
    loansResult,
    returnsResult,
    repairsResult,
    eventsResult,
    organizationsResult,
    membersResult,
    notificationsResult
  ] = await Promise.all([
    pool.query("SELECT value FROM app_settings WHERE key = 'runtime'"),
    pool.query("SELECT * FROM equipment_items ORDER BY code"),
    pool.query("SELECT * FROM rental_applications ORDER BY created_at DESC"),
    pool.query("SELECT * FROM rental_application_items ORDER BY id"),
    pool.query("SELECT * FROM reservations ORDER BY start_date, created_at"),
    pool.query("SELECT * FROM loans ORDER BY created_at DESC"),
    pool.query("SELECT * FROM return_inspections ORDER BY inspected_at DESC"),
    pool.query("SELECT * FROM repair_tickets ORDER BY created_at DESC"),
    pool.query("SELECT * FROM runtime_events ORDER BY created_at DESC LIMIT 300"),
    pool.query("SELECT * FROM equipment_organizations ORDER BY name"),
    pool.query("SELECT * FROM equipment_members ORDER BY created_at DESC"),
    pool.query("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 300")
  ]);

  const itemsByApplication = new Map();
  for (const row of applicationItemsResult.rows) {
    const list = itemsByApplication.get(row.application_id) || [];
    list.push({ itemId: row.item_id, quantity: Number(row.quantity) });
    itemsByApplication.set(row.application_id, list);
  }

  const inventory = inventoryResult.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    totalQuantity: Number(row.total_quantity),
    unavailableQuantity: Number(row.unavailable_quantity),
    rentableQuantity: Number(row.rentable_quantity),
    unit: row.unit,
    unitType: row.unit_type,
    rentable: row.rentable,
    keywords: parseJsonValue(row.keywords, []),
    notes: row.notes || ""
  }));

  return {
    source: "PostgreSQL",
    categories: uniqueValues(inventory.map((item) => item.category)),
    inventory,
    reservations: reservationsResult.rows.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      status: row.status,
      itemId: row.item_id,
      quantity: Number(row.quantity),
      startDate: dateOnly(row.start_date),
      endDate: dateOnly(row.end_date),
      organization: row.organization,
      createdAt: isoDateTime(row.created_at),
      expiresAt: isoDateTime(row.expires_at)
    })),
    applications: applicationsResult.rows.map((row) => ({
      id: row.id,
      status: row.status,
      organization: row.organization,
      applicant: row.applicant,
      email: row.email,
      startDate: dateOnly(row.start_date),
      endDate: dateOnly(row.end_date),
      purpose: row.purpose,
      deliveryMethod: row.delivery_method,
      staffMemo: row.staff_memo || "",
      timeline: parseJsonValue(row.timeline, []),
      items: itemsByApplication.get(row.id) || [],
      createdAt: isoDateTime(row.created_at),
      approvedAt: isoDateTime(row.approved_at),
      checkedOutAt: isoDateTime(row.checked_out_at),
      returnedAt: isoDateTime(row.returned_at),
      closedAt: isoDateTime(row.closed_at)
    })),
    loans: loansResult.rows.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      status: row.status,
      organization: row.organization,
      checkedOutBy: row.checked_out_by,
      checkedOutAt: isoDateTime(row.checked_out_at),
      dueAt: isoDateTime(row.due_at),
      items: parseJsonValue(row.items, []),
      returnedAt: isoDateTime(row.returned_at),
      closedAt: isoDateTime(row.closed_at)
    })),
    returnInspections: returnsResult.rows.map((row) => ({
      id: row.id,
      status: row.status,
      organization: row.organization,
      applicationId: row.application_id,
      loanId: row.loan_id,
      itemId: row.item_id,
      checkedOutQuantity: Number(row.checked_out_quantity),
      normalQuantity: Number(row.normal_quantity),
      damagedQuantity: Number(row.damaged_quantity),
      repairQuantity: Number(row.repair_quantity),
      lostQuantity: Number(row.lost_quantity),
      inspectedBy: row.inspected_by,
      inspectedAt: isoDateTime(row.inspected_at),
      note: row.note || "",
      trackingMode: row.tracking_mode
    })),
    repairTickets: repairsResult.rows.map((row) => ({
      id: row.id,
      inspectionId: row.inspection_id,
      applicationId: row.application_id,
      itemId: row.item_id,
      quantity: Number(row.quantity),
      issueType: row.issue_type,
      status: row.status,
      returnedToRentable: Number(row.returned_to_rentable),
      note: row.note || "",
      createdBy: row.created_by,
      createdAt: isoDateTime(row.created_at),
      updatedAt: isoDateTime(row.updated_at),
      resolvedAt: isoDateTime(row.resolved_at)
    })),
    events: eventsResult.rows.map((row) => ({
      id: row.id,
      type: row.type,
      actor: row.actor,
      role: row.role,
      payload: parseJsonValue(row.payload, {}),
      createdAt: isoDateTime(row.created_at)
    })),
    organizations: organizationsResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      managerEmail: row.manager_email || "",
      contactEmail: row.contact_email || "",
      notes: row.notes || "",
      createdAt: isoDateTime(row.created_at),
      updatedAt: isoDateTime(row.updated_at)
    })),
    members: membersResult.rows.map((row) => ({
      id: row.id,
      erpUserId: row.erp_user_id || "",
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      organizationId: row.organization_id || "",
      organization: row.organization || "",
      phone: row.phone || "",
      memo: row.memo || "",
      lastLoginAt: isoDateTime(row.last_login_at),
      createdAt: isoDateTime(row.created_at),
      updatedAt: isoDateTime(row.updated_at)
    })),
    notifications: notificationsResult.rows.map((row) => ({
      id: row.id,
      type: row.type,
      channel: row.channel,
      recipient: row.recipient,
      subject: row.subject || "",
      body: row.body || "",
      status: row.status,
      relatedId: row.related_id || null,
      dedupeKey: row.dedupe_key || null,
      attempts: Number(row.attempts || 0),
      error: row.error || null,
      createdAt: isoDateTime(row.created_at),
      sentAt: isoDateTime(row.sent_at),
      updatedAt: isoDateTime(row.updated_at)
    })),
    settings: {
      ...DEFAULT_SETTINGS,
      ...parseJsonValue(settingsResult.rows[0]?.value, {})
    }
  };
}

async function savePostgresRuntimeState(state) {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at)
      VALUES ('runtime', $1::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(state.settings || DEFAULT_SETTINGS)]
    );

    for (const item of state.inventoryItems || []) {
      await upsertPostgresInventory(client, item, "runtime");
    }
    for (const item of Object.values(state.inventoryOverrides || {})) {
      await upsertPostgresInventory(client, item, "runtime");
    }
    for (const application of state.applications || []) {
      await upsertPostgresApplication(client, application);
    }
    for (const reservation of state.reservations || []) {
      await upsertPostgresReservation(client, reservation);
    }
    for (const loan of state.loans || []) {
      await upsertPostgresLoan(client, loan);
    }
    for (const inspection of state.returnInspections || []) {
      await upsertPostgresReturnInspection(client, inspection);
    }
    for (const ticket of state.repairTickets || []) {
      await upsertPostgresRepairTicket(client, ticket);
    }
    for (const organization of state.organizations || []) {
      await upsertPostgresOrganization(client, organization);
    }
    for (const member of state.members || []) {
      await upsertPostgresMember(client, member);
    }
    for (const event of state.events || []) {
      await upsertPostgresEvent(client, event);
    }
    for (const notification of state.notifications || []) {
      await upsertPostgresNotification(client, notification);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  postgresEnabled,
  buildPgConfig,
  getPgPool,
  getPostgresSeed,
  savePostgresRuntimeState
};
