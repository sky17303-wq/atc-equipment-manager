const http = require("node:http");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHmac, randomUUID, timingSafeEqual } = require("node:crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_PATH = path.join(ROOT, "data", "seed-inventory.json");
const RUNTIME_STATE_PATH = process.env.RUNTIME_STATE_PATH || path.join(ROOT, "data", "runtime-state.json");
const RUNTIME_APPLICATIONS_PATH = path.join(ROOT, "data", "runtime-applications.json");
const RUNTIME_RETURNS_PATH = path.join(ROOT, "data", "runtime-returns.json");

loadEnv();

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH || "");
const AUTH_MODE = String(process.env.AUTH_MODE || process.env.EQUIPMENT_AUTH_MODE || "mock").toLowerCase();
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const ERP_LOGIN_URL = process.env.ERP_LOGIN_URL || "/erp/login?from=/equipment/";
const ERP_SESSION_COOKIE = process.env.ERP_SESSION_COOKIE || "erp_session";
const ERP_SESSION_SECRET = process.env.ERP_SESSION_SECRET || process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || "";

let seedCache = null;
let pgPool = null;

const DEFAULT_SETTINGS = {
  tentativeHoldHours: 24,
  returnBufferDays: 1,
  maxRentalDays: 14,
  emergencyReserveByItem: {}
};

const ROLE_USERS = {
  applicant: {
    id: "user-applicant",
    email: "user@ssem.re.kr",
    name: "일반 대여자",
    role: "applicant",
    organization: "새싹초등학교"
  },
  staff: {
    id: "user-staff",
    email: "staff@ssem.re.kr",
    name: "운영담당자",
    role: "staff",
    organization: "컴퓨팅교사협회"
  },
  admin: {
    id: "user-admin",
    email: "admin@ssem.re.kr",
    name: "관리자",
    role: "admin",
    organization: "컴퓨팅교사협회"
  },
  auditor: {
    id: "user-auditor",
    email: "auditor@ssem.re.kr",
    name: "조회담당자",
    role: "auditor",
    organization: "컴퓨팅교사협회"
  }
};

const MEMBER_ROLES = ["applicant", "staff", "admin", "auditor"];
const MEMBER_STATUSES = ["active", "pending", "suspended", "archived"];
const ORGANIZATION_TYPES = ["association", "school", "company", "individual_teacher", "partner", "other"];
const ORGANIZATION_STATUSES = ["active", "inactive"];
const AUTO_MEMBER_STATUS = MEMBER_STATUSES.includes(process.env.EQUIPMENT_AUTO_MEMBER_STATUS)
  ? process.env.EQUIPMENT_AUTO_MEMBER_STATUS
  : "pending";

const DEFAULT_ORGANIZATIONS = [
  {
    id: "org-association",
    name: "컴퓨팅교사협회",
    type: "association",
    status: "active",
    managerEmail: "staff@ssem.re.kr",
    contactEmail: "staff@ssem.re.kr",
    notes: "교구 운영 기본 기관"
  },
  {
    id: "org-school-seed",
    name: "새싹초등학교",
    type: "school",
    status: "active",
    managerEmail: "user@ssem.re.kr",
    contactEmail: "user@ssem.re.kr",
    notes: "신청 테스트용 학교"
  }
];

const DEFAULT_MEMBERS = Object.values(ROLE_USERS).map((user) => ({
  id: user.id,
  erpUserId: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  status: "active",
  organizationId: user.organization === "컴퓨팅교사협회" ? "org-association" : "org-school-seed",
  organization: user.organization,
  phone: "",
  memo: "기본 목업 계정",
  lastLoginAt: null,
  createdAt: new Date("2026-01-01T00:00:00+09:00").toISOString(),
  updatedAt: new Date("2026-01-01T00:00:00+09:00").toISOString()
}));

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".sql": "text/plain; charset=utf-8"
};

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fsSync.existsSync(envPath)) return;
  const raw = fsSync.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function normalizeBasePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function stripBasePath(url) {
  if (!BASE_PATH) return { ok: true, redirect: false };
  if (url.pathname === BASE_PATH) return { ok: true, redirect: true };
  if (url.pathname.startsWith(`${BASE_PATH}/`)) {
    url.pathname = url.pathname.slice(BASE_PATH.length) || "/";
    return { ok: true, redirect: false };
  }
  return { ok: true, redirect: false };
}

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

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function isoDateTime(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString();
}

function parseJsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
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
    eventsResult,
    organizationsResult,
    membersResult
  ] = await Promise.all([
    pool.query("SELECT value FROM app_settings WHERE key = 'runtime'"),
    pool.query("SELECT * FROM equipment_items ORDER BY code"),
    pool.query("SELECT * FROM rental_applications ORDER BY created_at DESC"),
    pool.query("SELECT * FROM rental_application_items ORDER BY id"),
    pool.query("SELECT * FROM reservations ORDER BY start_date, created_at"),
    pool.query("SELECT * FROM loans ORDER BY created_at DESC"),
    pool.query("SELECT * FROM return_inspections ORDER BY inspected_at DESC"),
    pool.query("SELECT * FROM runtime_events ORDER BY created_at DESC LIMIT 300"),
    pool.query("SELECT * FROM equipment_organizations ORDER BY name"),
    pool.query("SELECT * FROM equipment_members ORDER BY created_at DESC")
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
    settings: {
      ...DEFAULT_SETTINGS,
      ...parseJsonValue(settingsResult.rows[0]?.value, {})
    }
  };
}

async function getSeed() {
  if (postgresEnabled()) {
    return getPostgresSeed();
  }
  if (!seedCache) {
    seedCache = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
  }
  return seedCache;
}

function createRuntimeState() {
  return {
    applications: [],
    reservations: [],
    loans: [],
    returnInspections: [],
    inventoryItems: [],
    inventoryOverrides: {},
    organizations: [],
    members: [],
    events: [],
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: null
  };
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeRuntimeState(value) {
  const state = { ...createRuntimeState(), ...(value || {}) };
  state.applications = Array.isArray(state.applications) ? state.applications : [];
  state.reservations = Array.isArray(state.reservations) ? state.reservations : [];
  state.loans = Array.isArray(state.loans) ? state.loans : [];
  state.returnInspections = Array.isArray(state.returnInspections) ? state.returnInspections : [];
  state.inventoryItems = Array.isArray(state.inventoryItems) ? state.inventoryItems : [];
  state.inventoryOverrides = state.inventoryOverrides && typeof state.inventoryOverrides === "object"
    ? state.inventoryOverrides
    : {};
  state.organizations = Array.isArray(state.organizations) ? state.organizations : [];
  state.members = Array.isArray(state.members) ? state.members : [];
  state.events = Array.isArray(state.events) ? state.events : [];
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  return state;
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
    for (const organization of state.organizations || []) {
      await upsertPostgresOrganization(client, organization);
    }
    for (const member of state.members || []) {
      await upsertPostgresMember(client, member);
    }
    for (const event of state.events || []) {
      await upsertPostgresEvent(client, event);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertPostgresInventory(client, item, source) {
  await client.query(
    `INSERT INTO equipment_items (
      id, code, name, category, total_quantity, unavailable_quantity,
      rentable_quantity, unit, unit_type, rentable, keywords, notes, source
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (id) DO UPDATE SET
      code = EXCLUDED.code,
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      total_quantity = EXCLUDED.total_quantity,
      unavailable_quantity = EXCLUDED.unavailable_quantity,
      rentable_quantity = EXCLUDED.rentable_quantity,
      unit = EXCLUDED.unit,
      unit_type = EXCLUDED.unit_type,
      rentable = EXCLUDED.rentable,
      keywords = EXCLUDED.keywords,
      notes = EXCLUDED.notes,
      source = EXCLUDED.source,
      updated_at = now()`,
    [
      item.id,
      item.code,
      item.name,
      item.category,
      Number(item.totalQuantity || 0),
      Number(item.unavailableQuantity || 0),
      Number(item.rentableQuantity || 0),
      item.unit || "개",
      item.unitType || "quantity",
      item.rentable !== false,
      JSON.stringify(item.keywords || []),
      item.notes || "",
      source
    ]
  );
}

async function upsertPostgresApplication(client, application) {
  await client.query(
    `INSERT INTO rental_applications (
      id, status, organization, applicant, email, start_date, end_date,
      purpose, delivery_method, staff_memo, timeline, created_at,
      approved_at, checked_out_at, returned_at, closed_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      organization = EXCLUDED.organization,
      applicant = EXCLUDED.applicant,
      email = EXCLUDED.email,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      purpose = EXCLUDED.purpose,
      delivery_method = EXCLUDED.delivery_method,
      staff_memo = EXCLUDED.staff_memo,
      timeline = EXCLUDED.timeline,
      approved_at = EXCLUDED.approved_at,
      checked_out_at = EXCLUDED.checked_out_at,
      returned_at = EXCLUDED.returned_at,
      closed_at = EXCLUDED.closed_at,
      updated_at = now()`,
    [
      application.id,
      application.status,
      application.organization || "미입력",
      application.applicant || "미입력",
      application.email || "user@ssem.re.kr",
      application.startDate,
      application.endDate,
      application.purpose || "교구 대여",
      application.deliveryMethod || "pickup",
      application.staffMemo || null,
      JSON.stringify(application.timeline || []),
      application.createdAt || new Date().toISOString(),
      application.approvedAt || null,
      application.checkedOutAt || null,
      application.returnedAt || null,
      application.closedAt || null
    ]
  );

  for (const item of application.items || []) {
    await client.query(
      `INSERT INTO rental_application_items (application_id, item_id, quantity)
      VALUES ($1,$2,$3)
      ON CONFLICT (application_id, item_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [application.id, item.itemId, Number(item.quantity || item.requestedQuantity || 0)]
    );
  }
}

async function upsertPostgresReservation(client, reservation) {
  await client.query(
    `INSERT INTO reservations (
      id, application_id, item_id, quantity, start_date, end_date,
      status, organization, expires_at, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
    ON CONFLICT (id) DO UPDATE SET
      application_id = EXCLUDED.application_id,
      item_id = EXCLUDED.item_id,
      quantity = EXCLUDED.quantity,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      status = EXCLUDED.status,
      organization = EXCLUDED.organization,
      expires_at = EXCLUDED.expires_at,
      updated_at = now()`,
    [
      reservation.id,
      reservation.applicationId || null,
      reservation.itemId,
      Number(reservation.quantity || 0),
      reservation.startDate,
      reservation.endDate,
      reservation.status,
      reservation.organization || "미입력",
      reservation.expiresAt || null,
      reservation.createdAt || new Date().toISOString()
    ]
  );
}

async function upsertPostgresLoan(client, loan) {
  await client.query(
    `INSERT INTO loans (
      id, application_id, status, organization, checked_out_by,
      checked_out_at, due_at, items, returned_at, closed_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
    ON CONFLICT (id) DO UPDATE SET
      application_id = EXCLUDED.application_id,
      status = EXCLUDED.status,
      organization = EXCLUDED.organization,
      checked_out_by = EXCLUDED.checked_out_by,
      checked_out_at = EXCLUDED.checked_out_at,
      due_at = EXCLUDED.due_at,
      items = EXCLUDED.items,
      returned_at = EXCLUDED.returned_at,
      closed_at = EXCLUDED.closed_at,
      updated_at = now()`,
    [
      loan.id,
      loan.applicationId,
      loan.status,
      loan.organization || "미입력",
      loan.checkedOutBy || "운영담당자",
      loan.checkedOutAt || new Date().toISOString(),
      loan.dueAt,
      JSON.stringify(loan.items || []),
      loan.returnedAt || null,
      loan.closedAt || null
    ]
  );
}

async function upsertPostgresReturnInspection(client, inspection) {
  await client.query(
    `INSERT INTO return_inspections (
      id, status, organization, application_id, loan_id, item_id,
      checked_out_quantity, normal_quantity, damaged_quantity,
      repair_quantity, lost_quantity, inspected_by, inspected_at,
      note, tracking_mode
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      organization = EXCLUDED.organization,
      application_id = EXCLUDED.application_id,
      loan_id = EXCLUDED.loan_id,
      item_id = EXCLUDED.item_id,
      checked_out_quantity = EXCLUDED.checked_out_quantity,
      normal_quantity = EXCLUDED.normal_quantity,
      damaged_quantity = EXCLUDED.damaged_quantity,
      repair_quantity = EXCLUDED.repair_quantity,
      lost_quantity = EXCLUDED.lost_quantity,
      inspected_by = EXCLUDED.inspected_by,
      inspected_at = EXCLUDED.inspected_at,
      note = EXCLUDED.note,
      tracking_mode = EXCLUDED.tracking_mode`,
    [
      inspection.id,
      inspection.status || "completed",
      inspection.organization || "미입력",
      inspection.applicationId || null,
      inspection.loanId || null,
      inspection.itemId,
      Number(inspection.checkedOutQuantity || 0),
      Number(inspection.normalQuantity || 0),
      Number(inspection.damagedQuantity || 0),
      Number(inspection.repairQuantity || 0),
      Number(inspection.lostQuantity || 0),
      inspection.inspectedBy || "운영담당자",
      inspection.inspectedAt || new Date().toISOString(),
      inspection.note || "",
      inspection.trackingMode || "quantity"
    ]
  );
}

async function upsertPostgresOrganization(client, organization) {
  await client.query(
    `INSERT INTO equipment_organizations (
      id, name, type, status, manager_email, contact_email, notes, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      type = EXCLUDED.type,
      status = EXCLUDED.status,
      manager_email = EXCLUDED.manager_email,
      contact_email = EXCLUDED.contact_email,
      notes = EXCLUDED.notes,
      updated_at = now()`,
    [
      organization.id,
      organization.name,
      organization.type || "other",
      organization.status || "active",
      organization.managerEmail || null,
      organization.contactEmail || null,
      organization.notes || "",
      organization.createdAt || new Date().toISOString()
    ]
  );
}

async function upsertPostgresMember(client, member) {
  await client.query(
    `INSERT INTO equipment_members (
      id, erp_user_id, email, name, role, status, organization_id,
      organization, phone, memo, last_login_at, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
    ON CONFLICT (id) DO UPDATE SET
      erp_user_id = EXCLUDED.erp_user_id,
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      organization_id = EXCLUDED.organization_id,
      organization = EXCLUDED.organization,
      phone = EXCLUDED.phone,
      memo = EXCLUDED.memo,
      last_login_at = EXCLUDED.last_login_at,
      updated_at = now()`,
    [
      member.id,
      member.erpUserId || null,
      member.email,
      member.name,
      member.role || "applicant",
      member.status || "pending",
      member.organizationId || null,
      member.organization || "미지정",
      member.phone || "",
      member.memo || "",
      member.lastLoginAt || null,
      member.createdAt || new Date().toISOString()
    ]
  );
}

async function upsertPostgresEvent(client, event) {
  await client.query(
    `INSERT INTO runtime_events (id, type, actor, role, payload, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.type,
      event.actor || "시스템",
      event.role || "system",
      JSON.stringify(event.payload || {}),
      event.createdAt || new Date().toISOString()
    ]
  );
}

async function getRuntimeState() {
  if (postgresEnabled()) {
    return createRuntimeState();
  }
  const state = normalizeRuntimeState(await readJsonFile(RUNTIME_STATE_PATH, null));
  if (!state.updatedAt) {
    const legacyApplications = await readJsonFile(RUNTIME_APPLICATIONS_PATH, []);
    const legacyReturns = await readJsonFile(RUNTIME_RETURNS_PATH, []);
    if (Array.isArray(legacyApplications) && legacyApplications.length) {
      state.applications = mergeById([...state.applications, ...legacyApplications]);
    }
    if (Array.isArray(legacyReturns) && legacyReturns.length) {
      state.returnInspections = mergeById([...state.returnInspections, ...legacyReturns]);
    }
  }
  return state;
}

async function saveRuntimeState(state) {
  const normalized = normalizeRuntimeState(state);
  normalized.updatedAt = new Date().toISOString();
  if (postgresEnabled()) {
    await savePostgresRuntimeState(normalized);
    return;
  }
  await fs.writeFile(RUNTIME_STATE_PATH, JSON.stringify(normalized, null, 2), "utf8");
}

async function getRuntimeApplications() {
  const state = await getRuntimeState();
  return state.applications;
}

async function saveRuntimeApplications(applications) {
  const state = await getRuntimeState();
  state.applications = applications;
  await saveRuntimeState(state);
}

async function getRuntimeReturns() {
  const state = await getRuntimeState();
  return state.returnInspections;
}

async function saveRuntimeReturns(returns) {
  const state = await getRuntimeState();
  state.returnInspections = returns;
  await saveRuntimeState(state);
}

function mergeById(items) {
  const map = new Map();
  for (const item of items || []) {
    if (!item?.id) continue;
    map.set(item.id, item);
  }
  return [...map.values()];
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

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

function sendJson(res, payload, statusCode = 200) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, text, statusCode = 200, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function overlaps(startA, endA, startB, endB) {
  return startA <= endB && endA >= startB;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function normalizeDateInput(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDate(parsed);
}

function addHours(date, hours) {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

function authMode() {
  return ["mock", "hybrid", "supabase"].includes(AUTH_MODE) ? AUTH_MODE : "mock";
}

function mockAuthAllowed() {
  return authMode() === "mock" || authMode() === "hybrid";
}

function supabaseAuthEnabled() {
  return (authMode() === "supabase" || authMode() === "hybrid") &&
    Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function loginUrl() {
  return ERP_LOGIN_URL;
}

function parseCookieHeader(header = "") {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function looksLikeJwt(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function decodeCookieValue(value) {
  let decoded = String(value || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep raw value.
  }
  if (decoded.startsWith("base64-")) {
    try {
      decoded = base64UrlDecode(decoded.slice("base64-".length));
    } catch {
      return null;
    }
  }
  return decoded;
}

function accessTokenFromSessionValue(value) {
  const decoded = decodeCookieValue(value);
  if (!decoded) return null;
  if (looksLikeJwt(decoded)) return decoded;
  try {
    const session = JSON.parse(decoded);
    if (looksLikeJwt(session?.access_token)) return session.access_token;
    if (looksLikeJwt(session?.currentSession?.access_token)) return session.currentSession.access_token;
    if (Array.isArray(session)) {
      const token = session.find((entry) => looksLikeJwt(entry));
      if (token) return token;
    }
  } catch {
    return null;
  }
  return null;
}

function getSupabaseAccessToken(req) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (looksLikeJwt(bearer)) return bearer;

  const cookies = parseCookieHeader(req.headers.cookie || "");
  const grouped = new Map();
  for (const [name, value] of cookies.entries()) {
    if (!name.startsWith("sb-") || !name.includes("auth-token")) continue;
    const baseName = name.replace(/\.\d+$/, "");
    const group = grouped.get(baseName) || [];
    const chunk = Number(name.match(/\.(\d+)$/)?.[1] || 0);
    group.push({ chunk, value });
    grouped.set(baseName, group);
  }

  for (const group of grouped.values()) {
    const combined = group
      .sort((a, b) => a.chunk - b.chunk)
      .map((entry) => entry.value)
      .join("");
    const token = accessTokenFromSessionValue(combined);
    if (token) return token;
  }
  return null;
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decodeBase64UrlJson(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function verifySignedToken(token, secret) {
  if (!token || !secret || !String(token).includes(".")) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = base64UrlEncode(createHmac("sha256", secret).update(body).digest());
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  try {
    return decodeBase64UrlJson(body);
  } catch {
    return null;
  }
}

function erpSessionAuthEnabled() {
  return (authMode() === "supabase" || authMode() === "hybrid") && Boolean(ERP_SESSION_SECRET);
}

function getErpSession(req) {
  if (!erpSessionAuthEnabled()) return null;
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const token = cookies.get(ERP_SESSION_COOKIE);
  const session = verifySignedToken(token, ERP_SESSION_SECRET);
  if (!session?.user?.id || !session.user.email) return null;
  if (session.expires_at <= Math.floor(Date.now() / 1000)) return null;
  return session;
}

async function fetchSupabaseUser(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !accessToken) return null;
  const response = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) return null;
  return response.json();
}

function erpPermissionSyncEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

async function fetchSupabaseUserRows(table, select, filters, accessToken) {
  if (!erpPermissionSyncEnabled() || !accessToken) return null;
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  for (const [key, value] of Object.entries(filters || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, `eq.${value}`);
    }
  }

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`ERP permission lookup failed ${response.status}`);
  }
  return response.json();
}

async function fetchErpAccessForUser(user, accessToken) {
  if (!erpPermissionSyncEnabled() || !user?.id || !accessToken) return null;
  try {
    const email = normalizeEmail(user.email);
    let users = await fetchSupabaseUserRows("users", "id,email,name,is_super_admin", { id: user.id }, accessToken);
    if ((!users || users.length === 0) && email) {
      users = await fetchSupabaseUserRows("users", "id,email,name,is_super_admin", { email }, accessToken);
    }
    const erpUser = users?.[0];
    if (!erpUser?.id) return null;

    let memberships = [];
    try {
      memberships = await fetchSupabaseUserRows("memberships", "company_id,role,job_role", { user_id: erpUser.id }, accessToken) || [];
    } catch {
      memberships = await fetchSupabaseUserRows("memberships", "company_id,role", { user_id: erpUser.id }, accessToken) || [];
    }

    return {
      id: erpUser.id,
      email: normalizeEmail(erpUser.email || email),
      name: cleanText(erpUser.name, ""),
      isSuperAdmin: Boolean(erpUser.is_super_admin),
      memberships: memberships.map((membership) => ({
        role: membership.role || "member",
        jobRole: membership.job_role || "general"
      }))
    };
  } catch (error) {
    console.error("[auth] ERP permission sync skipped:", error.message);
    return null;
  }
}

function equipmentRoleFromErpAccess(access) {
  if (!access) return null;
  if (access.isSuperAdmin) return "admin";
  const roles = new Set(
    (access.memberships || []).flatMap((membership) => [membership.role, membership.jobRole])
  );
  if (roles.has("super_admin") || roles.has("representative") || roles.has("company_admin")) return "admin";
  if (roles.has("accounting")) return "auditor";
  return "applicant";
}

function equipmentStatusFromErpAccess(existing, access) {
  if (["suspended", "archived"].includes(existing?.status)) return existing.status;
  if (access?.id) return "active";
  return existing?.status || AUTO_MEMBER_STATUS;
}

function actorFromMember(member, authSource) {
  return {
    id: member.id,
    erpUserId: member.erpUserId || "",
    email: member.email,
    name: member.name,
    role: member.role,
    status: member.status || "active",
    organizationId: member.organizationId || "",
    organization: member.organization || "미지정",
    authenticated: true,
    authSource
  };
}

function guestActor() {
  return {
    id: "guest",
    email: "",
    name: "ERP 로그인 필요",
    role: "guest",
    status: "anonymous",
    organization: "",
    authenticated: false,
    authSource: "none"
  };
}

function findMemberForSupabaseUser(seed, user) {
  const email = normalizeEmail(user?.email);
  return (seed.members || []).find((member) =>
    member.erpUserId === user?.id ||
    normalizeEmail(member.email) === email
  );
}

function memberNeedsLoginSync(existing, next) {
  if (!existing) return true;
  if ((existing.erpUserId || "") !== (next.erpUserId || "")) return true;
  if (normalizeEmail(existing.email) !== normalizeEmail(next.email)) return true;
  if ((existing.name || "") !== (next.name || "")) return true;
  if ((existing.role || "") !== (next.role || "")) return true;
  if ((existing.status || "") !== (next.status || "")) return true;
  const lastLogin = existing.lastLoginAt ? new Date(existing.lastLoginAt).getTime() : 0;
  return !lastLogin || Date.now() - lastLogin > 30 * 60 * 1000;
}

async function resolveSupabaseActor(req, seed, runtime) {
  if (!supabaseAuthEnabled()) return null;
  const accessToken = getSupabaseAccessToken(req);
  if (!accessToken) return null;
  const user = await fetchSupabaseUser(accessToken);
  const email = normalizeEmail(user?.email);
  if (!user?.id || !isSsemEmail(email)) return null;

  const existing = findMemberForSupabaseUser(seed, user);
  const erpAccess = await fetchErpAccessForUser(user, accessToken);
  const erpRole = equipmentRoleFromErpAccess(erpAccess);
  const displayName = cleanText(
    erpAccess?.name ||
      user.user_metadata?.name ||
      user.user_metadata?.full_name ||
      user.user_metadata?.preferred_username ||
      existing?.name,
    email.split("@")[0]
  );
  const nextMember = normalizeMemberPayload(
    {
      id: existing?.id || `member-erp-${String(user.id).slice(0, 18).replace(/[^A-Za-z0-9_-]/g, "")}`,
      erpUserId: user.id,
      email: erpAccess?.email || email,
      name: displayName,
      role: erpRole || existing?.role || "applicant",
      status: equipmentStatusFromErpAccess(existing, erpAccess),
      organizationId: existing?.organizationId || "org-association",
      organization: existing?.organization || "컴퓨팅교사협회",
      phone: existing?.phone || "",
      memo: existing?.memo || "ERP/Supabase 로그인 자동 연결",
      lastLoginAt: new Date().toISOString()
    },
    existing || {},
    seed.organizations || []
  );

  if (memberNeedsLoginSync(existing, nextMember)) {
    upsertRuntimeEntry(runtime.members, nextMember);
    addRuntimeEvent(runtime, existing ? "member.login_synced" : "member.auto_created", {
      name: "ERP 자동 연결",
      role: "system"
    }, {
      memberId: nextMember.id,
      email: nextMember.email,
      status: nextMember.status
    });
    await saveRuntimeState(runtime);
  }

  return actorFromMember(nextMember, "supabase");
}

async function resolveErpSessionActor(req, seed, runtime) {
  const session = getErpSession(req);
  const user = session?.user;
  const email = normalizeEmail(user?.email);
  if (!user?.id || !isSsemEmail(email)) return null;

  const existing = findMemberForSupabaseUser(seed, user);
  const displayName = cleanText(
    user.user_metadata?.name ||
      user.user_metadata?.full_name ||
      user.user_metadata?.preferred_username ||
      existing?.name,
    email.split("@")[0]
  );
  const nextMember = normalizeMemberPayload(
    {
      id: existing?.id || `member-erp-${String(user.id).slice(0, 18).replace(/[^A-Za-z0-9_-]/g, "")}`,
      erpUserId: user.id,
      email,
      name: displayName,
      role: existing?.role || "applicant",
      status: existing?.status || AUTO_MEMBER_STATUS,
      organizationId: existing?.organizationId || "org-association",
      organization: existing?.organization || "",
      phone: existing?.phone || "",
      memo: existing?.memo || "ERP session login auto linked",
      lastLoginAt: new Date().toISOString()
    },
    existing || {},
    seed.organizations || []
  );

  if (memberNeedsLoginSync(existing, nextMember)) {
    upsertRuntimeEntry(runtime.members, nextMember);
    addRuntimeEvent(runtime, existing ? "member.login_synced" : "member.auto_created", {
      name: "ERP session login",
      role: "system"
    }, {
      memberId: nextMember.id,
      email: nextMember.email,
      status: nextMember.status
    });
    await saveRuntimeState(runtime);
  }

  return actorFromMember(nextMember, "erp_session");
}

async function getActor(req, seed, runtime) {
  const supabaseActor = await resolveSupabaseActor(req, seed, runtime);
  if (supabaseActor) return supabaseActor;

  const erpActor = await resolveErpSessionActor(req, seed, runtime);
  if (erpActor) return erpActor;

  if (mockAuthAllowed()) {
    const requestedRole = String(req.headers["x-user-role"] || "").toLowerCase();
    const role = ROLE_USERS[requestedRole] ? requestedRole : "staff";
    const mockUser = ROLE_USERS[role];
    const member = (seed.members || []).find((entry) => normalizeEmail(entry.email) === normalizeEmail(mockUser.email));
    return actorFromMember(member || mockUser, "mock");
  }

  return guestActor();
}

function requireRole(actor, res, roles) {
  if (!actor.authenticated) {
    sendJson(res, { error: "ERP 로그인이 필요합니다.", loginUrl: loginUrl() }, 401);
    return null;
  }
  if (actor.status !== "active") {
    sendJson(res, { error: `회원 상태가 ${actor.status}입니다. 관리자 승인 또는 상태 변경이 필요합니다.` }, 403);
    return null;
  }
  if (!roles.includes(actor.role)) {
    sendJson(res, { error: `${roles.join(", ")} 권한이 필요합니다.` }, 403);
    return null;
  }
  return actor;
}

function isSsemEmail(email) {
  return /^[^@\s]+@ssem\.re\.kr$/i.test(String(email || ""));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function choice(value, allowed, fallback) {
  const normalized = String(value || "").trim();
  return allowed.includes(normalized) ? normalized : fallback;
}

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

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function parseInventoryCsv(csv) {
  const lines = String(csv || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
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

function findItems(seed, prompt) {
  const lower = prompt.toLowerCase();
  const matches = seed.inventory
    .map((item) => {
      const keywordHits = item.keywords.filter((keyword) => lower.includes(keyword.toLowerCase()));
      const codeHit = lower.includes(item.code.toLowerCase()) ? 1 : 0;
      const nameHit = lower.includes(item.name.toLowerCase()) ? 1 : 0;
      return { item, score: keywordHits.length + codeHit + nameHit };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);

  return [...new Map(matches.map((item) => [item.id, item])).values()];
}

function inferQuantity(prompt, item) {
  const escapedKeywords = [item.name, item.code, ...item.keywords]
    .filter(Boolean)
    .map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const keywordPattern = escapedKeywords.join("|");
  const unitPattern = "(?:대|개|세트|권|box|박스)";
  const after = new RegExp(`(?:${keywordPattern})[^0-9\\n]{0,18}(\\d{1,4})\\s*${unitPattern}`, "i");
  const before = new RegExp(`(\\d{1,4})\\s*${unitPattern}[^\\n]{0,18}(?:${keywordPattern})`, "i");
  const afterMatch = prompt.match(after);
  const beforeMatch = prompt.match(before);
  const value = Number(afterMatch?.[1] || beforeMatch?.[1] || 0);
  return value > 0 ? value : 1;
}

function inferPurpose(prompt) {
  const known = ["AI 수업", "로봇 수업", "캠프", "교사연수", "연구회", "실습", "행사", "대회"];
  const hit = known.find((purpose) => prompt.includes(purpose));
  if (hit) return hit;
  if (prompt.includes("초등")) return "초등 SW/AI 수업";
  if (prompt.includes("중등")) return "중등 SW/AI 수업";
  return "교구 대여";
}

function inferOrganization(prompt) {
  const school = prompt.match(/([가-힣A-Za-z0-9]+(?:초등학교|중학교|고등학교|학교))/);
  const company = prompt.match(/([가-힣A-Za-z0-9]+(?:회사|교육팀|연구회|협회|센터))/);
  return school?.[1] || company?.[1] || "미입력";
}

function inferApplicant(prompt) {
  const teacher = prompt.match(/담당자는?\s*([가-힣A-Za-z0-9]+)|([가-힣A-Za-z0-9]+)\s*교사/);
  const raw = teacher?.[1] || teacher?.[2];
  if (!raw) return "미입력";
  return raw.replace(/(입니다|이에요|예요|이야|야|요)$/g, "");
}

function inferDateRange(prompt) {
  const now = new Date();
  const currentYear = now.getFullYear();

  const isoMatches = [...prompt.matchAll(/(20\d{2})[.\-\/년\s]+(\d{1,2})[.\-\/월\s]+(\d{1,2})/g)]
    .map((match) => `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`);
  if (isoMatches.length >= 2) return { startDate: isoMatches[0], endDate: isoMatches[1] };
  if (isoMatches.length === 1) return { startDate: isoMatches[0], endDate: isoMatches[0] };

  const mdMatches = [...prompt.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일?/g)]
    .map((match) => `${currentYear}-${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`);

  const mdRangeSameMonth = prompt.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일?\s*(?:부터|~|-|에서)\s*(\d{1,2})\s*일?\s*(?:까지)?/);
  if (mdRangeSameMonth) {
    const month = String(mdRangeSameMonth[1]).padStart(2, "0");
    const startDay = String(mdRangeSameMonth[2]).padStart(2, "0");
    const endDay = String(mdRangeSameMonth[3]).padStart(2, "0");
    return {
      startDate: `${currentYear}-${month}-${startDay}`,
      endDate: `${currentYear}-${month}-${endDay}`
    };
  }

  if (mdMatches.length >= 2) return { startDate: mdMatches[0], endDate: mdMatches[1] };
  if (mdMatches.length === 1) return { startDate: mdMatches[0], endDate: mdMatches[0] };

  if (prompt.includes("다음 주")) {
    const dayMap = {
      "월요일": 1,
      "화요일": 2,
      "수요일": 3,
      "목요일": 4,
      "금요일": 5,
      "토요일": 6,
      "일요일": 7
    };
    const mentioned = Object.entries(dayMap).filter(([label]) => prompt.includes(label));
    if (mentioned.length) {
      const today = now.getDay() || 7;
      const daysUntilNextMonday = 8 - today;
      const nextMonday = addDays(now, daysUntilNextMonday);
      const first = addDays(nextMonday, mentioned[0][1] - 1);
      const last = addDays(nextMonday, mentioned[mentioned.length - 1][1] - 1);
      return { startDate: formatDate(first), endDate: formatDate(last) };
    }
  }

  const defaultStart = addDays(now, 7);
  const defaultEnd = addDays(defaultStart, 2);
  return { startDate: formatDate(defaultStart), endDate: formatDate(defaultEnd) };
}

function suggestRobotBundle(seed, quantity, startDate, endDate) {
  const robotItems = seed.inventory.filter((item) => item.category === "로봇" && item.rentable);
  const selected = [];
  let remaining = quantity;
  for (const item of robotItems) {
    const availability = calculateAvailability(seed, item.id, startDate, endDate);
    if (!availability || availability.availableQuantity <= 0) continue;
    const take = Math.min(availability.availableQuantity, remaining);
    selected.push({ item, quantity: take, availability });
    remaining -= take;
    if (remaining <= 0) break;
  }
  return { selected, remaining };
}

function localParse(seed, prompt, explicitStartDate, explicitEndDate) {
  const dateRange = inferDateRange(prompt);
  const startDate = normalizeDateInput(explicitStartDate) || dateRange.startDate;
  const endDate = normalizeDateInput(explicitEndDate) || dateRange.endDate;
  const matchedItems = findItems(seed, prompt);
  const purpose = inferPurpose(prompt);
  const organization = inferOrganization(prompt);
  const applicant = inferApplicant(prompt);

  if (!matchedItems.length && /로봇|AI|인공지능|수업/.test(prompt)) {
    const requestedQuantity = Number(prompt.match(/(\d{1,4})\s*(?:대|개|세트)/)?.[1] || 30);
    const bundle = suggestRobotBundle(seed, requestedQuantity, startDate, endDate);
    return {
      source: "local",
      purpose,
      organization,
      applicant,
      startDate,
      endDate,
      requestedItems: bundle.selected.map(({ item, quantity }) => ({
        itemId: item.id,
        code: item.code,
        name: item.name,
        quantity
      })),
      bundleShortage: bundle.remaining
    };
  }

  return {
    source: "local",
    purpose,
    organization,
    applicant,
    startDate,
    endDate,
    requestedItems: matchedItems.map((item) => ({
      itemId: item.id,
      code: item.code,
      name: item.name,
      quantity: inferQuantity(prompt, item)
    }))
  };
}

function stripJsonFence(text) {
  return text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function parseWithGemini(seed, prompt, explicitStartDate, explicitEndDate) {
  if (!process.env.GEMINI_API_KEY) return null;

  const catalog = seed.inventory.map((item) => ({
    itemId: item.id,
    code: item.code,
    name: item.name,
    category: item.category,
    unit: item.unit,
    keywords: item.keywords
  }));

  const extractionPrompt = [
    "너는 컴퓨팅교사협회 교구 대여 신청을 구조화하는 운영 보조 AI다.",
    "재고 가능 여부는 계산하지 말고, 사용자 요청에서 구조화 정보만 추출한다.",
    "반드시 JSON만 반환한다. 마크다운 코드블록을 쓰지 않는다.",
    "JSON 스키마:",
    "{",
    '  "purpose": "string",',
    '  "organization": "string|null",',
    '  "applicant": "string|null",',
    '  "startDate": "YYYY-MM-DD|null",',
    '  "endDate": "YYYY-MM-DD|null",',
    '  "requestedItems": [{ "itemId": "string|null", "code": "string|null", "name": "string", "quantity": number }]',
    "}",
    `명시 시작일: ${explicitStartDate || "없음"}`,
    `명시 종료일: ${explicitEndDate || "없음"}`,
    `교구 카탈로그: ${JSON.stringify(catalog)}`,
    `사용자 요청: ${prompt}`
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: extractionPrompt }] }]
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${message.slice(0, 240)}`);
  }

  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") || "";
  if (!text) return null;

  const parsed = JSON.parse(stripJsonFence(text));
  const localFallback = localParse(seed, prompt, explicitStartDate, explicitEndDate);

  const requestedItems = (parsed.requestedItems || [])
    .map((requested) => {
      const item = seed.inventory.find((entry) =>
        entry.id === requested.itemId ||
        entry.code === requested.code ||
        entry.name === requested.name ||
        entry.keywords.some((keyword) => keyword.toLowerCase() === String(requested.name || "").toLowerCase())
      );
      if (!item) return null;
      return {
        itemId: item.id,
        code: item.code,
        name: item.name,
        quantity: Number(requested.quantity || 10)
      };
    })
    .filter(Boolean);

  return {
    source: "gemini",
    purpose: parsed.purpose || localFallback.purpose,
    organization: parsed.organization || localFallback.organization,
    applicant: parsed.applicant || localFallback.applicant,
    startDate: normalizeDateInput(explicitStartDate) || normalizeDateInput(parsed.startDate) || localFallback.startDate,
    endDate: normalizeDateInput(explicitEndDate) || normalizeDateInput(parsed.endDate) || localFallback.endDate,
    requestedItems: requestedItems.length ? requestedItems : localFallback.requestedItems
  };
}

function buildAiResponse(seed, parsed, prompt) {
  const availability = parsed.requestedItems.map((requested) => {
    const result = calculateAvailability(seed, requested.itemId, parsed.startDate, parsed.endDate);
    return {
      ...result,
      requestedQuantity: requested.quantity,
      possible: Boolean(result && result.availableQuantity >= requested.quantity)
    };
  });

  const possibleCount = availability.filter((entry) => entry.possible).length;
  const allPossible = availability.length > 0 && possibleCount === availability.length && !parsed.bundleShortage;
  const status = allPossible ? "available" : "needs_adjustment";
  const draftItems = availability.map((entry) => ({
    itemId: entry.item.id,
    code: entry.item.code,
    name: entry.item.name,
    requestedQuantity: entry.requestedQuantity,
    availableQuantity: entry.availableQuantity,
    possible: entry.possible
  }));

  let message;
  if (!availability.length) {
    message = "요청에서 교구 품목을 찾지 못했습니다. 품목명이나 수량을 한 번 더 적어주세요.";
  } else if (allPossible) {
    message = `${parsed.startDate}부터 ${parsed.endDate}까지 요청 수량을 대여할 수 있습니다. 담당자 승인 전 신청서 초안으로 저장됩니다.`;
  } else {
    const shortage = availability
      .filter((entry) => !entry.possible)
      .map((entry) => `${entry.item.name} 부족 ${entry.requestedQuantity - entry.availableQuantity}${entry.item.unit}`)
      .join(", ");
    message = `일부 수량 조정이 필요합니다. ${shortage || `부족 ${parsed.bundleShortage}대`}`;
  }

  return {
    mode: parsed.source,
    prompt,
    message,
    status,
    parsed,
    availability,
    draft: {
      id: `draft-${Date.now()}`,
      status: "draft",
      organization: parsed.organization,
      applicant: parsed.applicant,
      email: "user@ssem.re.kr",
      purpose: parsed.purpose,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      items: draftItems
    }
  };
}

async function handleApi(req, res, url) {
  const { seed, runtime } = await getSystemState();
  const actor = await getActor(req, seed, runtime);

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

  if (req.method === "GET" && url.pathname === "/api/members") {
    const allowedActor = requireRole(actor, res, ["staff", "admin", "auditor"]);
    if (!allowedActor) return true;

    sendJson(res, {
      members: seed.members || [],
      organizations: seed.organizations || [],
      summary: buildMemberSummary(seed),
      roles: MEMBER_ROLES,
      statuses: MEMBER_STATUSES,
      organizationTypes: ORGANIZATION_TYPES
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/organizations") {
    const allowedActor = requireRole(actor, res, ["admin"]);
    if (!allowedActor) return true;

    const body = await readBody(req);
    const organization = normalizeOrganizationPayload(body);
    if (!organization.name) {
      sendJson(res, { error: "기관명이 필요합니다." }, 400);
      return true;
    }
    const duplicate = (seed.organizations || []).find((entry) =>
      entry.name.trim().toLowerCase() === organization.name.trim().toLowerCase()
    );
    if (duplicate) {
      sendJson(res, { error: "이미 존재하는 기관명입니다." }, 409);
      return true;
    }

    upsertRuntimeEntry(runtime.organizations, organization);
    addRuntimeEvent(runtime, "organization.created", allowedActor, {
      organizationId: organization.id,
      name: organization.name
    });
    await saveRuntimeState(runtime);
    sendJson(res, { organization }, 201);
    return true;
  }

  const organizationMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)$/);
  if (organizationMatch && req.method === "PUT") {
    const allowedActor = requireRole(actor, res, ["admin"]);
    if (!allowedActor) return true;

    const organizationId = decodeURIComponent(organizationMatch[1]);
    const existing = (seed.organizations || []).find((entry) => entry.id === organizationId);
    if (!existing) {
      sendJson(res, { error: "기관을 찾을 수 없습니다." }, 404);
      return true;
    }

    const body = await readBody(req);
    const organization = normalizeOrganizationPayload(body, existing);
    if (!organization.name) {
      sendJson(res, { error: "기관명이 필요합니다." }, 400);
      return true;
    }
    const duplicate = (seed.organizations || []).find((entry) =>
      entry.id !== organizationId &&
      entry.name.trim().toLowerCase() === organization.name.trim().toLowerCase()
    );
    if (duplicate) {
      sendJson(res, { error: "이미 존재하는 기관명입니다." }, 409);
      return true;
    }

    upsertRuntimeEntry(runtime.organizations, organization);
    addRuntimeEvent(runtime, "organization.updated", allowedActor, {
      organizationId: organization.id,
      name: organization.name,
      status: organization.status
    });
    await saveRuntimeState(runtime);
    sendJson(res, { organization });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/members") {
    const allowedActor = requireRole(actor, res, ["admin"]);
    if (!allowedActor) return true;

    const body = await readBody(req);
    const member = normalizeMemberPayload(body, {}, seed.organizations || []);
    if (!member.name || !member.email) {
      sendJson(res, { error: "이름과 이메일이 필요합니다." }, 400);
      return true;
    }
    if (!isSsemEmail(member.email)) {
      sendJson(res, { error: "@ssem.re.kr 이메일만 등록할 수 있습니다." }, 400);
      return true;
    }
    if (member.organizationId && !(seed.organizations || []).some((entry) => entry.id === member.organizationId)) {
      sendJson(res, { error: "선택한 기관을 찾을 수 없습니다." }, 400);
      return true;
    }
    const duplicate = (seed.members || []).find((entry) => normalizeEmail(entry.email) === member.email);
    if (duplicate) {
      sendJson(res, { error: "이미 등록된 이메일입니다." }, 409);
      return true;
    }

    upsertRuntimeEntry(runtime.members, member);
    addRuntimeEvent(runtime, "member.created", allowedActor, {
      memberId: member.id,
      email: member.email,
      role: member.role
    });
    await saveRuntimeState(runtime);
    sendJson(res, { member }, 201);
    return true;
  }

  const memberMatch = url.pathname.match(/^\/api\/members\/([^/]+)$/);
  if (memberMatch && req.method === "PUT") {
    const allowedActor = requireRole(actor, res, ["admin"]);
    if (!allowedActor) return true;

    const memberId = decodeURIComponent(memberMatch[1]);
    const existing = (seed.members || []).find((entry) => entry.id === memberId);
    if (!existing) {
      sendJson(res, { error: "회원을 찾을 수 없습니다." }, 404);
      return true;
    }

    const body = await readBody(req);
    const member = normalizeMemberPayload(body, existing, seed.organizations || []);
    if (!member.name || !member.email) {
      sendJson(res, { error: "이름과 이메일이 필요합니다." }, 400);
      return true;
    }
    if (!isSsemEmail(member.email)) {
      sendJson(res, { error: "@ssem.re.kr 이메일만 등록할 수 있습니다." }, 400);
      return true;
    }
    if (member.organizationId && !(seed.organizations || []).some((entry) => entry.id === member.organizationId)) {
      sendJson(res, { error: "선택한 기관을 찾을 수 없습니다." }, 400);
      return true;
    }
    const duplicate = (seed.members || []).find((entry) =>
      entry.id !== memberId &&
      normalizeEmail(entry.email) === member.email
    );
    if (duplicate) {
      sendJson(res, { error: "이미 등록된 이메일입니다." }, 409);
      return true;
    }

    upsertRuntimeEntry(runtime.members, member);
    addRuntimeEvent(runtime, "member.updated", allowedActor, {
      memberId: member.id,
      email: member.email,
      role: member.role,
      status: member.status
    });
    await saveRuntimeState(runtime);
    sendJson(res, { member });
    return true;
  }

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

  if (req.method === "POST" && url.pathname === "/api/applications") {
    const allowedActor = requireRole(actor, res, ["applicant", "staff", "admin"]);
    if (!allowedActor) return true;

    const body = await readBody(req);
    if (!body.draft || !Array.isArray(body.draft.items)) {
      sendJson(res, { error: "draft.items가 필요합니다." }, 400);
      return true;
    }

    const email = body.draft.email || allowedActor.email;
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

  if (req.method === "POST" && url.pathname === "/api/inventory") {
    const allowedActor = requireRole(actor, res, ["admin"]);
    if (!allowedActor) return true;

    const body = await readBody(req);
    const item = normalizeInventoryPayload(body);
    if (!item.code || !item.name) {
      sendJson(res, { error: "품목 코드와 품목명이 필요합니다." }, 400);
      return true;
    }
    if (seed.inventory.some((entry) => entry.code === item.code)) {
      sendJson(res, { error: "이미 존재하는 품목 코드입니다." }, 409);
      return true;
    }
    item.id = `item-local-${randomUUID().slice(0, 8)}`;
    item.createdAt = new Date().toISOString();
    runtime.inventoryItems.unshift(item);
    addRuntimeEvent(runtime, "inventory.created", allowedActor, { itemId: item.id, code: item.code });
    await saveRuntimeState(runtime);
    sendJson(res, { item }, 201);
    return true;
  }

  const inventoryMatch = url.pathname.match(/^\/api\/inventory\/([^/]+)$/);
  if (req.method === "PUT" && inventoryMatch) {
    const allowedActor = requireRole(actor, res, ["admin"]);
    if (!allowedActor) return true;

    const itemId = decodeURIComponent(inventoryMatch[1]);
    const body = await readBody(req);
    const existing = seed.inventory.find((item) => item.id === itemId || item.code === itemId);
    if (!existing) {
      sendJson(res, { error: "수정할 품목을 찾을 수 없습니다." }, 404);
      return true;
    }
    const item = normalizeInventoryPayload(body, existing);
    if (runtime.inventoryItems.some((entry) => entry.id === existing.id)) {
      runtime.inventoryItems = runtime.inventoryItems.map((entry) =>
        entry.id === existing.id ? { ...item, id: existing.id } : entry
      );
    } else {
      runtime.inventoryOverrides[existing.id] = { ...item, id: existing.id };
    }
    addRuntimeEvent(runtime, "inventory.updated", allowedActor, { itemId: existing.id, code: item.code });
    await saveRuntimeState(runtime);
    sendJson(res, { item: { ...item, id: existing.id } });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/inventory/import") {
    const allowedActor = requireRole(actor, res, ["admin"]);
    if (!allowedActor) return true;

    const body = await readBody(req);
    const rows = parseInventoryCsv(body.csv);
    const imported = [];
    for (const row of rows) {
      const existing = seed.inventory.find((item) => item.code === String(row.code || "").trim().toUpperCase());
      const item = normalizeInventoryPayload(row, existing || {});
      if (!item.code || !item.name) continue;
      if (existing) {
        runtime.inventoryOverrides[existing.id] = { ...item, id: existing.id };
        imported.push({ ...item, id: existing.id, mode: "updated" });
      } else {
        const created = {
          ...item,
          id: `item-local-${randomUUID().slice(0, 8)}`,
          createdAt: new Date().toISOString()
        };
        runtime.inventoryItems.unshift(created);
        imported.push({ ...created, mode: "created" });
      }
    }
    addRuntimeEvent(runtime, "inventory.imported", allowedActor, { count: imported.length });
    await saveRuntimeState(runtime);
    sendJson(res, { imported });
    return true;
  }

  return false;
}

async function serveStatic(req, res, url) {
  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === "/") requestedPath = "/index.html";
  const rootDir = requestedPath.startsWith("/docs/") || requestedPath.startsWith("/database/")
    ? ROOT
    : PUBLIC_DIR;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(rootDir, safePath);

  if (!filePath.startsWith(rootDir)) {
    sendText(res, "Forbidden", 403);
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    const acceptsHtml = String(req.headers.accept || "").includes("text/html");
    const hasExtension = Boolean(path.extname(requestedPath));

    // SPA fallback: allow direct links such as /equipment/dashboard to load the app shell.
    if (req.method === "GET" && acceptsHtml && !hasExtension) {
      try {
        const indexPath = path.join(PUBLIC_DIR, "index.html");
        const content = await fs.readFile(indexPath);
        res.writeHead(200, {
          "Content-Type": CONTENT_TYPES[".html"] || "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end(content);
        return;
      } catch {
        // Fall through to the normal 404 if the app shell is unavailable.
      }
    }

    sendText(res, "Not found", 404);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    const basePathResult = stripBasePath(url);
    if (basePathResult.redirect) {
      res.writeHead(302, { Location: `${BASE_PATH}/` });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, { error: "Not found" }, 404);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

if (require.main === module) {
  server.listen(PORT, HOST || undefined, () => {
    console.log(`ATC equipment manager running at http://${HOST || "localhost"}:${PORT}`);
  });
}

module.exports = {
  server,
  loadEnv,
  BASE_PATH,
  calculateAvailability,
  localParse,
  buildAiResponse,
  parseInventoryCsv,
  postgresEnabled
};
