const fsSync = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_PATH = path.join(ROOT, "data", "seed-inventory.json");
const RUNTIME_STATE_PATH = process.env.RUNTIME_STATE_PATH || path.join(ROOT, "data", "runtime-state.json");
const RUNTIME_APPLICATIONS_PATH = path.join(ROOT, "data", "runtime-applications.json");
const RUNTIME_RETURNS_PATH = path.join(ROOT, "data", "runtime-returns.json");

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

loadEnv();

function normalizeBasePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

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

module.exports = {
  ROOT,
  PUBLIC_DIR,
  DATA_PATH,
  RUNTIME_STATE_PATH,
  RUNTIME_APPLICATIONS_PATH,
  RUNTIME_RETURNS_PATH,
  loadEnv,
  normalizeBasePath,
  PORT,
  HOST,
  GEMINI_MODEL,
  BASE_PATH,
  AUTH_MODE,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  ERP_LOGIN_URL,
  ERP_SESSION_COOKIE,
  ERP_SESSION_SECRET,
  DEFAULT_SETTINGS,
  ROLE_USERS,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  ORGANIZATION_TYPES,
  ORGANIZATION_STATUSES,
  AUTO_MEMBER_STATUS,
  DEFAULT_ORGANIZATIONS,
  DEFAULT_MEMBERS,
  CONTENT_TYPES
};
