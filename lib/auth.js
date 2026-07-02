const { createHmac, timingSafeEqual } = require("node:crypto");

const {
  AUTH_MODE,
  AUTO_MEMBER_STATUS,
  ERP_LOGIN_URL,
  ERP_SESSION_COOKIE,
  ERP_SESSION_SECRET,
  ROLE_USERS,
  SUPABASE_URL,
  SUPABASE_ANON_KEY
} = require("./config");
const { cleanText, isSsemEmail, normalizeEmail } = require("./utils");
const {
  sendJson,
  parseCookieHeader,
  base64UrlDecode,
  base64UrlEncode,
  decodeBase64UrlJson,
  looksLikeJwt
} = require("./http-utils");
const { saveRuntimeState } = require("./storage");
const { normalizeMemberPayload, upsertRuntimeEntry, addRuntimeEvent } = require("./domain");

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

module.exports = {
  authMode,
  mockAuthAllowed,
  supabaseAuthEnabled,
  loginUrl,
  decodeCookieValue,
  accessTokenFromSessionValue,
  getSupabaseAccessToken,
  verifySignedToken,
  erpSessionAuthEnabled,
  getErpSession,
  fetchSupabaseUser,
  erpPermissionSyncEnabled,
  fetchSupabaseUserRows,
  fetchErpAccessForUser,
  equipmentRoleFromErpAccess,
  equipmentStatusFromErpAccess,
  actorFromMember,
  guestActor,
  findMemberForSupabaseUser,
  memberNeedsLoginSync,
  resolveSupabaseActor,
  resolveErpSessionActor,
  getActor,
  requireRole
};
