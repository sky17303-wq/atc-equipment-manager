const { MEMBER_ROLES, MEMBER_STATUSES, ORGANIZATION_TYPES } = require("./config");
const { isSsemEmail, normalizeEmail } = require("./utils");
const { sendJson, readBody } = require("./http-utils");
const { saveRuntimeState } = require("./storage");
const { requireRole } = require("./auth");
const {
  addRuntimeEvent,
  buildMemberSummary,
  normalizeMemberPayload,
  normalizeOrganizationPayload,
  upsertRuntimeEntry
} = require("./domain");

// 기관/회원 관리 API (/api/members, /api/organizations)
async function handleMembersApi(context) {
  const { req, res, url, seed, runtime, actor } = context;

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

  return false;
}

module.exports = { handleMembersApi };
