const path = require("node:path");
const os = require("node:os");

process.env.RUNTIME_STATE_PATH = path.join(os.tmpdir(), `equipment-runtime-verify-${Date.now()}.json`);

const { server } = require("../server");

const port = Number(process.env.VERIFY_PORT || 5341);
const baseUrl = `http://localhost:${port}`;

function headers(role) {
  return {
    "Content-Type": "application/json",
    "X-User-Role": role
  };
}

async function getJson(pathname, role = "staff") {
  const response = await fetch(`${baseUrl}${pathname}`, { headers: headers(role) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function postJson(pathname, role, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: headers(role),
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

// 실패(4xx)가 기대되는 호출: 기대한 상태 코드가 아니면 오류를 던진다.
async function postExpectStatus(pathname, role, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: headers(role),
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`${pathname} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function putJson(pathname, role, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "PUT",
    headers: headers(role),
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function run() {
  const health = await getJson("/api/health");
  const ai = await postJson("/api/ai/request", "applicant", {
    prompt: "6월 20일부터 21일까지 햄스터S 3대 빌릴 수 있어? 기관은 테스트초등학교고 담당자는 박교사야.",
    startDate: "2026-06-20",
    endDate: "2026-06-21"
  });
  const submitted = await postJson("/api/applications", "applicant", { draft: ai.draft });
  const applicationId = submitted.application.id;
  const approved = await postJson(`/api/applications/${encodeURIComponent(applicationId)}/approve`, "staff", {});
  const checkedOut = await postJson(`/api/applications/${encodeURIComponent(applicationId)}/checkout`, "staff", {});
  const returned = await postJson(`/api/applications/${encodeURIComponent(applicationId)}/return`, "staff", {});
  const loan = checkedOut.loans.find((entry) => entry.applicationId === applicationId);
  const inspected = await postJson("/api/returns/inspect", "staff", {
    applicationId,
    loanId: loan.id,
    itemId: "r01",
    organization: "테스트초등학교",
    checkedOutQuantity: 3,
    normalQuantity: 2,
    damagedQuantity: 1,
    repairQuantity: 0,
    lostQuantity: 0,
    note: "검증 스크립트 검수"
  });
  const created = await postJson("/api/inventory", "admin", {
    code: "ZZ1",
    name: "검증 교구",
    category: "테스트",
    totalQuantity: 5,
    unavailableQuantity: 0,
    rentableQuantity: 5,
    unit: "개",
    unitType: "quantity",
    notes: "검증용"
  });
  const organization = await postJson("/api/organizations", "admin", {
    name: "검증초등학교",
    type: "school",
    status: "active",
    managerEmail: "verify-manager@ssem.re.kr",
    contactEmail: "verify@ssem.re.kr",
    notes: "검증용 기관"
  });
  const member = await postJson("/api/members", "admin", {
    name: "검증 담당자",
    email: "verify-member@ssem.re.kr",
    organizationId: organization.organization.id,
    role: "staff",
    status: "pending",
    memo: "검증용 회원"
  });
  const updatedMember = await putJson(`/api/members/${encodeURIComponent(member.member.id)}`, "admin", {
    ...member.member,
    status: "active",
    role: "admin"
  });
  const members = await getJson("/api/members", "staff");
  const stats = await getJson("/api/stats");
  const labels = await getJson("/api/labels?limit=3");

  // 사용자별 데이터 범위 제한: applicant는 본인(user@ssem.re.kr) 신청만 조회된다.
  const staffApplications = await getJson("/api/applications", "staff");
  const applicantApplications = await getJson("/api/applications", "applicant");
  const applicantScopeOk =
    applicantApplications.applications.length >= 1 &&
    applicantApplications.applications.every((entry) => entry.email === "user@ssem.re.kr") &&
    staffApplications.applications.length >= applicantApplications.applications.length;
  const applicantInventory = await getJson("/api/inventory", "applicant");
  const reservationScopeOk = applicantInventory.reservations.every((reservation) =>
    reservation.applicationId === null ||
    applicantApplications.applications.some((entry) => entry.id === reservation.applicationId)
  );

  // --- 다품목 품목별 부분 검수 + 수리 티켓 시나리오 ---
  const inventoryBefore = await getJson("/api/inventory", "staff");
  const r06Before = inventoryBefore.inventory.find((item) => item.id === "r06");

  const multi = await postJson("/api/applications", "applicant", {
    draft: {
      organization: "테스트초등학교",
      applicant: "박교사",
      purpose: "다품목 부분 검수 검증",
      startDate: "2026-07-06",
      endDate: "2026-07-07",
      items: [
        { itemId: "r01", quantity: 2 },
        { itemId: "r06", quantity: 1 }
      ]
    }
  });
  const multiId = multi.application.id;
  await postJson(`/api/applications/${encodeURIComponent(multiId)}/approve`, "staff", {});
  const multiCheckedOut = await postJson(`/api/applications/${encodeURIComponent(multiId)}/checkout`, "staff", {});
  await postJson(`/api/applications/${encodeURIComponent(multiId)}/return`, "staff", {});
  const multiLoan = multiCheckedOut.loans.find((entry) => entry.applicationId === multiId);

  // 품목 1 검수: 부분 검수라 신청은 returned 유지
  const partialPayload = {
    applicationId: multiId,
    loanId: multiLoan.id,
    itemId: "r01",
    organization: "테스트초등학교",
    checkedOutQuantity: 2,
    normalQuantity: 2,
    damagedQuantity: 0,
    repairQuantity: 0,
    lostQuantity: 0,
    note: "다품목 부분 검수 1/2"
  };
  const partial = await postJson("/api/returns/inspect", "staff", partialPayload);

  // 같은 품목 중복 검수는 409
  await postExpectStatus("/api/returns/inspect", "staff", partialPayload, 409);

  // 품목 2 검수(파손 1 포함): 전 품목 완료 → 신청 closed + 수리 티켓 자동 생성
  const finalInspection = await postJson("/api/returns/inspect", "staff", {
    applicationId: multiId,
    loanId: multiLoan.id,
    itemId: "r06",
    organization: "테스트초등학교",
    checkedOutQuantity: 1,
    normalQuantity: 0,
    damagedQuantity: 1,
    repairQuantity: 0,
    lostQuantity: 0,
    note: "다품목 부분 검수 2/2 (파손 1)"
  });

  const applicationsAfterMulti = await getJson("/api/applications", "staff");
  const multiLoanAfter = applicationsAfterMulti.loans.find((entry) => entry.applicationId === multiId);

  const repairs = await getJson("/api/repairs", "staff");
  const multiTicket = repairs.repairTickets.find((entry) => entry.inspectionId === finalInspection.inspection.id);
  const inRepair = await postJson(`/api/repairs/${encodeURIComponent(multiTicket.id)}/status`, "staff", {
    status: "in_repair",
    note: "수리 업체 발송"
  });
  const resolved = await postJson(`/api/repairs/${encodeURIComponent(multiTicket.id)}/status`, "staff", {
    status: "resolved",
    returnedToRentable: 1,
    note: "수리 완료 후 재고 복귀"
  });
  // resolved 후 검수 차감(파손 1)이 상쇄되어 r06 재고가 원상 복구되어야 한다.
  const inventoryAfter = await getJson("/api/inventory", "staff");
  const r06After = inventoryAfter.inventory.find((item) => item.id === "r06");

  const result = {
    health: health.ok,
    aiStatus: ai.status,
    submitted: submitted.application.status,
    approved: approved.application.status,
    checkedOut: checkedOut.application.status,
    returned: returned.application.status,
    inspected: inspected.inspection.status,
    created: created.item.code,
    organization: organization.organization.name,
    member: updatedMember.member.role,
    memberStatus: updatedMember.member.status,
    memberCount: members.summary.total,
    statsItems: stats.totals.items,
    labels: labels.labels.length,
    applicantScope: applicantScopeOk,
    reservationScope: reservationScopeOk,
    multiPartialStatus: partial.application?.status,
    multiPartialPending: partial.applicationProgress?.pendingItemIds?.join(","),
    multiClosedStatus: finalInspection.application?.status,
    multiLoanClosed: multiLoanAfter?.status,
    repairTicketStatus: multiTicket?.status,
    repairTicketQuantity: multiTicket?.quantity,
    repairInRepair: inRepair.repairTicket.status,
    repairResolved: resolved.repairTicket.status,
    repairInventoryRestored:
      r06After.rentableQuantity === r06Before.rentableQuantity &&
      r06After.unavailableQuantity === r06Before.unavailableQuantity
  };

  console.log(JSON.stringify(result, null, 2));

  const passed =
    result.health &&
    result.aiStatus === "available" &&
    result.submitted === "submitted" &&
    result.approved === "approved" &&
    result.checkedOut === "checked_out" &&
    result.returned === "returned" &&
    result.inspected === "completed" &&
    result.created === "ZZ1" &&
    result.organization === "검증초등학교" &&
    result.member === "admin" &&
    result.memberStatus === "active" &&
    result.memberCount === 5 &&
    result.statsItems === 21 &&
    result.labels === 3 &&
    result.applicantScope &&
    result.reservationScope &&
    result.multiPartialStatus === "returned" &&
    result.multiPartialPending === "r06" &&
    result.multiClosedStatus === "closed" &&
    result.multiLoanClosed === "closed" &&
    result.repairTicketStatus === "open" &&
    result.repairTicketQuantity === 1 &&
    result.repairInRepair === "in_repair" &&
    result.repairResolved === "resolved" &&
    result.repairInventoryRestored;

  if (!passed) throw new Error("verification failed");
}

server.listen(port, async () => {
  try {
    await run();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
