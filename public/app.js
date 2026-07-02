const state = {
  inventory: [],
  categories: [],
  reservations: [],
  applications: [],
  loans: [],
  returnInspections: [],
  repairTickets: [],
  members: [],
  organizations: [],
  memberSummary: null,
  labels: [],
  stats: null,
  notifications: [],
  currentCategory: "전체",
  currentMemberStatus: "전체",
  currentDraft: null,
  currentRole: localStorage.getItem("equipmentRole") || "staff",
  session: null,
  editingItemId: null,
  editingMemberId: null,
  editingOrganizationId: null,
  activeReturnApplicationId: null,
  activeReturnLoanId: null,
  scanStream: null,
  scanTimer: null,
  scanDetector: null,
  reportLoaded: false
};

const titles = {
  dashboard: "교구 운영 대시보드",
  ai: "AI 대여 신청",
  inventory: "교구 목록",
  calendar: "예약 캘린더",
  operations: "승인/반출/반납",
  scan: "QR 스캔",
  members: "회원 관리",
  stats: "통계/라벨",
  erd: "DB/ERD 초안"
};

const roleLabels = {
  applicant: "일반 대여자",
  staff: "담당자",
  admin: "관리자",
  auditor: "조회 전용"
};

const memberStatusLabels = {
  active: "활성",
  pending: "승인대기",
  suspended: "정지",
  archived: "보관"
};

const repairStatusLabels = {
  open: "접수",
  in_repair: "수리중",
  resolved: "복귀완료",
  scrapped: "폐기"
};

const repairIssueLabels = {
  damaged: "파손",
  repair: "수리",
  mixed: "파손+수리"
};

const notificationStatusLabels = {
  pending: "대기",
  sent: "발송됨",
  failed: "실패",
  skipped: "건너뜀"
};

const notificationTypeLabels = {
  "application.approved": "승인 안내",
  "application.rejected": "반려 안내",
  "application.checked_out": "반출 안내",
  "application.returned": "반납 접수",
  "application.closed": "검수 완료",
  "application.due_soon": "반납 임박",
  "application.overdue": "반납 연체"
};

const notificationChannelLabels = {
  email: "이메일",
  kakao: "알림톡"
};

const organizationTypeLabels = {
  association: "협회",
  school: "학교",
  company: "회사",
  individual_teacher: "개인 교사",
  partner: "협력기관",
  other: "기타"
};

const formatNumber = new Intl.NumberFormat("ko-KR");
const appBasePath = inferBasePath();

function inferBasePath() {
  const firstSegment = window.location.pathname.split("/").filter(Boolean)[0];
  return firstSegment ? `/${firstSegment}` : "";
}

function appPath(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${appBasePath}${normalized}`;
}

function qs(selector) {
  return document.querySelector(selector);
}

function qsa(selector) {
  return [...document.querySelectorAll(selector)];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(appPath(url), {
    headers: {
      "Content-Type": "application/json",
      "X-User-Role": state.currentRole,
      ...(options.headers || {})
    },
    ...options
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

function switchView(section) {
  // QR 스캔 화면을 벗어나면 카메라를 정지해 배터리/권한 점유를 줄인다.
  if (section !== "scan") stopScan();
  // 교구 목록 첫 진입 시에만 엑셀 파서(SheetJS)를 미리 로드한다 (초기 로딩 무게 방지).
  if (section === "inventory") ensureXlsxLoaded().catch(() => {});
  // 통계 화면 첫 진입 시 기본 기간(최근 30일) 리포트를 자동 조회한다.
  if (section === "stats" && !state.reportLoaded) {
    const panel = qs("#report-panel");
    if (panel && !panel.hidden) {
      state.reportLoaded = true;
      loadReport().catch(() => {});
    }
  }
  qsa(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.section === section);
  });
  qsa(".view").forEach((view) => {
    view.classList.toggle("active-view", view.id === section);
  });
  qs("#page-title").textContent = titles[section] || "교구 관리";
}

function itemById(itemId) {
  return state.inventory.find((item) => item.id === itemId || item.code === itemId);
}

function organizationById(organizationId) {
  return state.organizations.find((organization) => organization.id === organizationId);
}

function loanByApplication(applicationId) {
  return state.loans.find((loan) => loan.applicationId === applicationId);
}

function applicationStatusLabel(status) {
  return {
    draft: "초안",
    submitted: "승인대기",
    approved: "승인완료",
    rejected: "반려",
    checked_out: "반출",
    returned: "검수대기",
    closed: "종결",
    canceled: "취소"
  }[status] || status;
}

function reservationStatusLabel(status) {
  return {
    tentative: "승인대기",
    confirmed: "예약확정",
    checked_out: "반출중",
    returned: "반납완료",
    canceled: "취소"
  }[status] || status;
}

function statusTone(status) {
  return ["submitted", "tentative", "returned"].includes(status) ? "warn" : "neutral";
}

function memberStatusTone(status) {
  if (status === "active") return "neutral";
  if (status === "pending") return "warn";
  return "bad";
}

function applicationItemsText(application) {
  return application.items.map((line) => {
    const item = itemById(line.itemId);
    return `${item?.name || line.itemId} ${formatNumber.format(line.quantity || line.requestedQuantity || 0)}${item?.unit || ""}`;
  }).join(", ");
}

function updateSessionPanel() {
  const user = state.session?.user;
  if (!user) {
    qs("#session-name").textContent = "ERP 로그인 필요";
    qs("#session-email").textContent = "class4edu.co.kr/erp";
    qs("#role-select").disabled = false;
    return;
  }
  qs("#session-name").textContent = `${user.name} · ${roleLabels[user.role] || user.role}`;
  qs("#session-email").textContent = user.email;
  qs("#role-select").value = user.role;
  qs("#role-select").disabled = state.session?.authSource === "supabase";
}

function renderLoginRequired(session) {
  updateSessionPanel();
  switchView("dashboard");
  qs("#dashboard").innerHTML = `
    <section class="panel auth-required">
      <div>
        <p class="eyebrow">ERP 계정 연동</p>
        <h2>교구 운영 사이트를 사용하려면 ERP 로그인이 필요합니다.</h2>
        <p>같은 도메인의 ERP 로그인 세션을 확인한 뒤 교구 회원 정보와 자동 연결합니다.</p>
      </div>
      <a class="primary-action" href="${escapeHtml(session.loginUrl || "/erp/login?from=/equipment/")}">ERP 로그인</a>
    </section>
  `;
}

function renderMetrics() {
  const totals = state.stats?.totals;
  const rentableTotal = totals?.rentableQuantity ?? state.inventory.reduce((sum, item) => sum + item.rentableQuantity, 0);
  const occupied = state.reservations
    .filter((reservation) => ["tentative", "confirmed", "checked_out"].includes(reservation.status))
    .reduce((sum, reservation) => sum + reservation.quantity, 0);
  const submitted = state.applications.filter((application) => application.status === "submitted").length;

  qs("#metric-items").textContent = formatNumber.format(totals?.items ?? state.inventory.length);
  qs("#metric-rentable").textContent = formatNumber.format(rentableTotal);
  qs("#metric-submitted").textContent = formatNumber.format(submitted);
  qs("#metric-occupied").textContent = formatNumber.format(occupied);
}

function renderPendingList() {
  const pending = state.applications.filter((application) => application.status === "submitted").slice(0, 4);
  qs("#pending-list").innerHTML = pending.length
    ? pending.map((application) => `
      <div class="compact-item">
        <strong>${escapeHtml(application.organization)}</strong>
        <small>${escapeHtml(application.purpose)} · ${application.startDate} ~ ${application.endDate}</small>
        <small>${escapeHtml(applicationItemsText(application))}</small>
      </div>
    `).join("")
    : `<div class="compact-item"><strong>대기 건 없음</strong><small>제출된 신청이 없습니다.</small></div>`;
}

function renderIssueList() {
  const inspectionIssues = new Map();
  for (const inspection of state.returnInspections) {
    const abnormal = inspection.damagedQuantity + inspection.repairQuantity + inspection.lostQuantity;
    if (abnormal <= 0) continue;
    inspectionIssues.set(inspection.itemId, (inspectionIssues.get(inspection.itemId) || 0) + abnormal);
  }

  // 미해결(open/in_repair) 수리 티켓 수를 재고 이슈에 반영한다.
  const openRepairByItem = new Map();
  let openRepairCount = 0;
  for (const ticket of state.repairTickets) {
    if (!["open", "in_repair"].includes(ticket.status)) continue;
    openRepairCount += 1;
    openRepairByItem.set(ticket.itemId, (openRepairByItem.get(ticket.itemId) || 0) + 1);
  }

  const issues = state.inventory
    .filter((item) => item.unavailableQuantity > 0 || inspectionIssues.has(item.id) || openRepairByItem.has(item.id) || item.notes.includes("세트화"))
    .slice(0, 5);
  const repairSummary = openRepairCount > 0
    ? `<div class="compact-item">
        <strong>미해결 수리 티켓 ${formatNumber.format(openRepairCount)}건</strong>
        <small>승인/반출/반납 화면의 수리 티켓 패널에서 처리하세요.</small>
      </div>`
    : "";
  qs("#issue-list").innerHTML = issues.length || repairSummary
    ? `${repairSummary}${issues.map((item) => `
      <div class="compact-item">
        <strong>${escapeHtml(item.code)} ${escapeHtml(item.name)}</strong>
        <small>제외 ${formatNumber.format(item.unavailableQuantity)}${item.unit} · 반납불량 ${formatNumber.format(inspectionIssues.get(item.id) || 0)}${item.unit} · 수리티켓 ${formatNumber.format(openRepairByItem.get(item.id) || 0)}건 · ${escapeHtml(item.notes || "확인 필요")}</small>
      </div>
    `).join("")}`
    : `<div class="compact-item"><strong>이슈 없음</strong><small>현재 표시할 재고 이슈가 없습니다.</small></div>`;
}

function renderCategoryFilters() {
  const filters = ["전체", ...state.categories];
  qs("#category-filters").innerHTML = filters.map((category) => `
    <button class="filter-chip ${category === state.currentCategory ? "active" : ""}" type="button" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>
  `).join("");
}

function renderInventory() {
  const query = qs("#inventory-search")?.value.trim().toLowerCase() || "";
  const rows = state.inventory.filter((item) => {
    const categoryMatch = state.currentCategory === "전체" || item.category === state.currentCategory;
    const queryMatch = !query || [item.code, item.name, item.category, item.notes].join(" ").toLowerCase().includes(query);
    return categoryMatch && queryMatch;
  });

  qs("#inventory-body").innerHTML = rows.map((item) => `
    <tr>
      <td><strong>${escapeHtml(item.code)}</strong></td>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>${formatNumber.format(item.totalQuantity)}${escapeHtml(item.unit)}</td>
      <td>${formatNumber.format(item.unavailableQuantity)}${escapeHtml(item.unit)}</td>
      <td>${formatNumber.format(item.rentableQuantity)}${escapeHtml(item.unit)}</td>
      <td>${escapeHtml(item.notes)}</td>
      <td><button class="small-action" type="button" data-inventory-edit="${escapeHtml(item.id)}">수정</button></td>
    </tr>
  `).join("");
}

function renderReservations() {
  qs("#reservation-timeline").innerHTML = state.reservations.length
    ? state.reservations.map((reservation) => {
      const item = itemById(reservation.itemId);
      return `
        <div class="timeline-item">
          <div>
            <strong>${escapeHtml(reservation.startDate)}</strong>
            <small>${escapeHtml(reservation.endDate)}까지</small>
          </div>
          <div>
            <strong>${escapeHtml(item?.name || reservation.itemId)} ${formatNumber.format(reservation.quantity)}${escapeHtml(item?.unit || "")}</strong>
            <div class="timeline-bar" aria-hidden="true"></div>
            <small>${escapeHtml(reservation.organization)}${reservation.applicationId ? ` · ${escapeHtml(reservation.applicationId)}` : ""}</small>
          </div>
          <span class="status-pill ${statusTone(reservation.status)}">${reservationStatusLabel(reservation.status)}</span>
        </div>
      `;
    }).join("")
    : `<div class="compact-item"><strong>예약 없음</strong><small>현재 표시할 예약 점유가 없습니다.</small></div>`;
}

function applicationActions(application) {
  const status = application.status;
  const buttons = [
    ["approve", "승인", status !== "submitted"],
    ["reject", "반려", !["submitted", "approved"].includes(status)],
    ["checkout", "반출", status !== "approved"],
    ["return", "반납", status !== "checked_out"],
    ["inspect", "검수 준비", status !== "returned"]
  ];
  return buttons.map(([action, label, disabled]) => `
    <button class="small-action" type="button" data-app-action="${action}" data-app-id="${escapeHtml(application.id)}" ${disabled ? "disabled" : ""}>${label}</button>
  `).join("");
}

function renderApplications() {
  qs("#application-board").innerHTML = state.applications.length
    ? state.applications.map((application) => {
      const latest = application.timeline?.[0];
      const loan = loanByApplication(application.id);
      return `
        <div class="application-item">
          <div>
            <strong>${escapeHtml(application.organization)} · ${escapeHtml(application.applicant)}</strong>
            <small>${escapeHtml(application.purpose)} · ${application.startDate} ~ ${application.endDate}</small>
            <small>${escapeHtml(applicationItemsText(application))}</small>
            ${loan ? `<small>반출번호 ${escapeHtml(loan.id)} · ${escapeHtml(loan.status)}</small>` : ""}
            ${latest ? `<small>최근 이력: ${escapeHtml(latest.type)} · ${escapeHtml(latest.actor)} · ${escapeHtml(latest.at)}</small>` : ""}
          </div>
          <div class="application-actions">
            <span class="status-pill ${statusTone(application.status)}">${applicationStatusLabel(application.status)}</span>
            ${applicationActions(application)}
          </div>
        </div>
      `;
    }).join("")
    : `<div class="compact-item"><strong>신청 없음</strong><small>아직 신청 데이터가 없습니다.</small></div>`;
}

function renderMemberSummary() {
  const summary = state.memberSummary || {};
  qs("#member-summary").innerHTML = [
    ["전체 회원", summary.total || 0],
    ["활성", summary.active || 0],
    ["승인대기", summary.pending || 0],
    ["정지", summary.suspended || 0],
    ["운영 담당", summary.staff || 0],
    ["관리자", summary.admins || 0],
    ["기관", summary.organizations || 0]
  ].map(([label, value]) => `
    <div class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${formatNumber.format(value)}</strong>
    </div>
  `).join("");
}

function renderMemberOptions() {
  qs("#member-organization").innerHTML = state.organizations
    .map((organization) => `
      <option value="${escapeHtml(organization.id)}">${escapeHtml(organization.name)} · ${escapeHtml(organizationTypeLabels[organization.type] || organization.type)}</option>
    `).join("");
}

function renderMembers() {
  const query = qs("#member-search")?.value.trim().toLowerCase() || "";
  const status = state.currentMemberStatus;
  const rows = state.members.filter((member) => {
    const statusMatch = status === "전체" || member.status === status;
    const queryMatch = !query || [
      member.name,
      member.email,
      member.organization,
      member.erpUserId,
      roleLabels[member.role],
      memberStatusLabels[member.status]
    ].join(" ").toLowerCase().includes(query);
    return statusMatch && queryMatch;
  });

  qs("#member-body").innerHTML = rows.length
    ? rows.map((member) => {
      const applications = state.memberSummary?.applicationsByEmail?.[member.email] || 0;
      return `
        <tr>
          <td>
            <strong>${escapeHtml(member.name)}</strong>
            <small>${escapeHtml(member.email)}</small>
            <small>신청 ${formatNumber.format(applications)}건</small>
          </td>
          <td>${escapeHtml(member.organization || organizationById(member.organizationId)?.name || "미지정")}</td>
          <td><span class="status-pill neutral">${escapeHtml(roleLabels[member.role] || member.role)}</span></td>
          <td><span class="status-pill ${memberStatusTone(member.status)}">${escapeHtml(memberStatusLabels[member.status] || member.status)}</span></td>
          <td>${escapeHtml(member.erpUserId || "-")}</td>
          <td><button class="small-action" type="button" data-member-edit="${escapeHtml(member.id)}">수정</button></td>
        </tr>
      `;
    }).join("")
    : `<tr><td colspan="6">조건에 맞는 회원이 없습니다.</td></tr>`;
}

function renderOrganizations() {
  qs("#organization-list").innerHTML = state.organizations.length
    ? state.organizations.map((organization) => {
      const memberCount = state.members.filter((member) => member.organizationId === organization.id).length;
      return `
        <div class="compact-item">
          <strong>${escapeHtml(organization.name)}</strong>
          <small>${escapeHtml(organizationTypeLabels[organization.type] || organization.type)} · ${organization.status === "active" ? "활성" : "비활성"} · 회원 ${formatNumber.format(memberCount)}명</small>
          <small>${escapeHtml(organization.managerEmail || "담당자 미지정")} · ${escapeHtml(organization.notes || "메모 없음")}</small>
          <div class="form-actions">
            <button class="small-action" type="button" data-organization-edit="${escapeHtml(organization.id)}">기관 수정</button>
          </div>
        </div>
      `;
    }).join("")
    : `<div class="compact-item"><strong>기관 없음</strong><small>회원 소속 기관을 먼저 등록하세요.</small></div>`;
}

function renderReturnItemOptions() {
  qs("#return-item").innerHTML = state.inventory
    .filter((item) => item.rentable)
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.code)} ${escapeHtml(item.name)} (${escapeHtml(item.unit)})</option>`)
    .join("");
}

function renderReturnInspections() {
  const list = state.returnInspections.slice(0, 8);
  qs("#return-inspection-list").innerHTML = list.length
    ? list.map((inspection) => {
      const item = itemById(inspection.itemId);
      const abnormal = inspection.damagedQuantity + inspection.repairQuantity + inspection.lostQuantity;
      return `
        <div class="compact-item">
          <strong>${escapeHtml(inspection.organization)} · ${escapeHtml(item?.name || inspection.itemId)}</strong>
          <small>반출 ${formatNumber.format(inspection.checkedOutQuantity)}${escapeHtml(item?.unit || "")} · 정상 ${formatNumber.format(inspection.normalQuantity)} · 불량/제외 ${formatNumber.format(abnormal)}</small>
          <div class="condition-summary">
            <span>파손 ${formatNumber.format(inspection.damagedQuantity)}</span>
            <span>수리 ${formatNumber.format(inspection.repairQuantity)}</span>
            <span>분실 ${formatNumber.format(inspection.lostQuantity)}</span>
          </div>
          <small>${escapeHtml(inspection.note || "메모 없음")}</small>
        </div>
      `;
    }).join("")
    : `<div class="compact-item"><strong>검수 이력 없음</strong><small>번호 없는 교구 반납 검수 기록이 아직 없습니다.</small></div>`;
}

function activeReturnApplication() {
  return state.applications.find((entry) => entry.id === state.activeReturnApplicationId) || null;
}

// 해당 신청에서 이미 검수 기록이 있는 품목 ID 집합
function inspectedItemIdsFor(applicationId) {
  return new Set(
    state.returnInspections
      .filter((inspection) => inspection.applicationId === applicationId)
      .map((inspection) => inspection.itemId)
  );
}

// 신청 품목별 검수 진행 상황(검수됨/대기) 목록. 품목 클릭 시 검수 폼에 채운다.
function renderReturnProgress() {
  const container = qs("#return-application-progress");
  const application = activeReturnApplication();
  if (!application || application.status !== "returned") {
    container.innerHTML = "";
    return;
  }
  const inspected = inspectedItemIdsFor(application.id);
  container.innerHTML = `
    <div class="compact-item">
      <strong>${escapeHtml(application.organization)} · ${escapeHtml(application.id)}</strong>
      <small>품목별 검수 대기 목록 — 품목을 클릭하면 아래 폼에 채워집니다. 전 품목 검수 시 신청이 종결됩니다.</small>
    </div>
    ${application.items.map((line) => {
      const item = itemById(line.itemId);
      const done = inspected.has(line.itemId);
      const quantity = Number(line.quantity || line.requestedQuantity || 0);
      return `
        <button class="compact-item return-progress-item" type="button" data-return-pick="${escapeHtml(line.itemId)}" ${done ? "disabled" : ""}>
          <strong>${escapeHtml(item?.name || line.itemId)} ${formatNumber.format(quantity)}${escapeHtml(item?.unit || "")}</strong>
          <small><span class="status-pill ${done ? "neutral" : "warn"}">${done ? "검수됨" : "검수 대기"}</span></small>
        </button>
      `;
    }).join("")}
  `;
}

function repairTicketActions(ticket, canManage) {
  const buttons = [];
  if (ticket.status === "open") buttons.push(["in_repair", "수리 시작"]);
  if (ticket.status === "in_repair") {
    buttons.push(["resolved", "수리 완료"]);
    buttons.push(["scrapped", "폐기"]);
  }
  return buttons.map(([action, label]) => `
    <button class="small-action" type="button" data-repair-action="${action}" data-repair-id="${escapeHtml(ticket.id)}" ${canManage ? "" : "disabled"}>${label}</button>
  `).join("");
}

function repairStatusTone(status) {
  if (status === "scrapped") return "bad";
  if (status === "resolved") return "neutral";
  return "warn";
}

function renderRepairTickets() {
  const effectiveRole = state.session?.user?.role || state.currentRole;
  const canManage = ["staff", "admin"].includes(effectiveRole);
  const tickets = state.repairTickets.slice(0, 12);
  qs("#repair-ticket-list").innerHTML = tickets.length
    ? tickets.map((ticket) => {
      const item = itemById(ticket.itemId);
      return `
        <div class="compact-item">
          <strong>${escapeHtml(item?.name || ticket.itemId)} ${formatNumber.format(ticket.quantity)}${escapeHtml(item?.unit || "")} · ${escapeHtml(repairIssueLabels[ticket.issueType] || ticket.issueType)}</strong>
          <small>${escapeHtml(ticket.id)} · 검수 ${escapeHtml(ticket.inspectionId || "-")} · ${escapeHtml(ticket.createdBy || "")}</small>
          <small>${escapeHtml(ticket.note || "메모 없음")}</small>
          ${ticket.status === "resolved" ? `<small>재고 복귀 ${formatNumber.format(ticket.returnedToRentable || 0)}${escapeHtml(item?.unit || "")}</small>` : ""}
          <div class="form-actions">
            <span class="status-pill ${repairStatusTone(ticket.status)}">${escapeHtml(repairStatusLabels[ticket.status] || ticket.status)}</span>
            ${repairTicketActions(ticket, canManage)}
          </div>
        </div>
      `;
    }).join("")
    : `<div class="compact-item"><strong>수리 티켓 없음</strong><small>반납 검수에서 파손/수리 수량이 기록되면 자동 생성됩니다.</small></div>`;
}

async function handleRepairAction(action, ticketId) {
  const ticket = state.repairTickets.find((entry) => entry.id === ticketId);
  if (!ticket) return;
  const payload = { status: action };
  if (action === "resolved") {
    const input = prompt(`재고로 복귀할 수량을 입력하세요 (0 ~ ${ticket.quantity})`, String(ticket.quantity));
    if (input === null) return;
    const returned = Number(input);
    if (!Number.isFinite(returned) || returned < 0 || returned > ticket.quantity) {
      alert(`0 이상 ${ticket.quantity} 이하의 숫자를 입력하세요.`);
      return;
    }
    payload.returnedToRentable = returned;
  }
  if (action === "scrapped" && !confirm("해당 수량을 폐기 처리할까요? 재고로 복귀되지 않습니다.")) return;

  try {
    await fetchJson(`/api/repairs/${encodeURIComponent(ticketId)}/status`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    await loadData();
  } catch (error) {
    alert(error.message);
  }
}

function updateReturnHint() {
  const checkedOut = Number(qs("#return-checked-out").value || 0);
  const total = ["#return-normal", "#return-damaged", "#return-repair", "#return-lost"]
    .map((selector) => Number(qs(selector).value || 0))
    .reduce((sum, value) => sum + value, 0);
  const hint = qs("#return-total-hint");
  hint.textContent = checkedOut === total
    ? `검수 합계 ${formatNumber.format(total)}개, 기록 가능`
    : `반출 ${formatNumber.format(checkedOut)}개 / 검수 합계 ${formatNumber.format(total)}개`;
  hint.style.color = checkedOut === total ? "var(--teal-strong)" : "var(--coral)";
}

function renderStats() {
  const stats = state.stats;
  if (!stats) return;
  const totals = stats.totals;
  qs("#stats-grid").innerHTML = [
    ["전체 품목", totals.items],
    ["총 보유", totals.totalQuantity],
    ["대여 기준", totals.rentableQuantity],
    ["대여 제외", totals.unavailableQuantity],
    ["신청", totals.applications],
    ["반출 건", totals.loans],
    ["검수", totals.returns],
    ["연체", totals.overdue]
  ].map(([label, value]) => `
    <div class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${formatNumber.format(value)}</strong>
    </div>
  `).join("");

  qs("#category-stats").innerHTML = stats.categoryStats.map((category) => `
    <div class="compact-item">
      <strong>${escapeHtml(category.category)}</strong>
      <small>품목 ${formatNumber.format(category.itemCount)} · 총 ${formatNumber.format(category.totalQuantity)} · 대여 기준 ${formatNumber.format(category.rentableQuantity)} · 제외 ${formatNumber.format(category.unavailableQuantity)}</small>
    </div>
  `).join("");
}

// ---------------------------------------------------------------------------
// 기간별 운영 리포트 (사용률/파손율/연체율) — staff/admin/auditor 전용
// ---------------------------------------------------------------------------

function formatPercent(rate) {
  return `${(Number(rate || 0) * 100).toFixed(1)}%`;
}

function formatDateInput(date) {
  return date.toISOString().slice(0, 10);
}

// 기본 조회 기간: 최근 30일 (오늘 포함)
function setDefaultReportRange() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  qs("#report-start-date").value = formatDateInput(start);
  qs("#report-end-date").value = formatDateInput(end);
}

// applicant에게는 리포트 패널을 숨긴다 (수리 티켓/알림 패널과 같은 role 처리 패턴).
function updateReportPanelVisibility() {
  const panel = qs("#report-panel");
  if (!panel) return;
  const effectiveRole = state.session?.user?.role || state.currentRole;
  panel.hidden = !["staff", "admin", "auditor"].includes(effectiveRole);
}

function renderReport(report) {
  const container = qs("#report-result");
  if (!container) return;
  const totals = report.totals;
  const statusLine = Object.entries(totals.applicationsByStatus || {})
    .map(([status, count]) => `${applicationStatusLabel(status)} ${formatNumber.format(count)}`)
    .join(" · ") || "기간 내 신청 없음";

  const metricCards = [
    ["기간 내 신청", formatNumber.format(totals.applications)],
    ["반출 건수", formatNumber.format(totals.checkouts)],
    ["반납 검수", formatNumber.format(totals.inspections)],
    ["파손/분실율", formatPercent(report.damage.total.rate)],
    ["기한 초과 반납", formatNumber.format(report.overdue.returnedLate)],
    ["미반납 연체", formatNumber.format(report.overdue.unreturned)],
    ["수리 접수/해결", `${formatNumber.format(report.repairs.created)} / ${formatNumber.format(report.repairs.resolved)}`],
    ["미해결 수리", formatNumber.format(report.repairs.open)]
  ].map(([label, value]) => `
    <div class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </div>
  `).join("");

  const topItems = report.topItems.length
    ? report.topItems.map((entry, index) => `
      <div class="compact-item">
        <strong>${index + 1}. ${escapeHtml(entry.code)} ${escapeHtml(entry.name)}</strong>
        <small>대여 ${formatNumber.format(entry.rentalCount)}회 · ${formatNumber.format(entry.rentalQuantity)}${escapeHtml(entry.unit)} · 점유 ${formatNumber.format(entry.occupiedDayQuantity)}개·일 · 사용률 ${formatPercent(entry.utilizationRate)}</small>
      </div>
    `).join("")
    : `<div class="compact-item"><strong>대여 활동 없음</strong><small>기간 내 대여 품목이 없습니다.</small></div>`;

  const categories = report.categoryUtilization
    .filter((entry) => entry.itemCount > 0)
    .map((entry) => `
      <div class="compact-item">
        <strong>${escapeHtml(entry.category)} · 사용률 ${formatPercent(entry.utilizationRate)}</strong>
        <small>점유 ${formatNumber.format(entry.occupiedDayQuantity)}개·일 / 용량 ${formatNumber.format(entry.capacityDayQuantity)}개·일 (대여 기준 × ${formatNumber.format(report.period.days)}일)</small>
      </div>
    `).join("");

  const damageItems = report.damage.byItem.length
    ? report.damage.byItem.map((entry) => `
      <div class="compact-item">
        <strong>${escapeHtml(entry.code)} ${escapeHtml(entry.name)} · ${formatPercent(entry.rate)}</strong>
        <small>반출 ${formatNumber.format(entry.checkedOut)} 중 파손/수리/분실 ${formatNumber.format(entry.abnormal)}</small>
      </div>
    `).join("")
    : `<div class="compact-item"><strong>검수 이력 없음</strong><small>기간 내 반납 검수 기록이 없습니다.</small></div>`;

  const overdueList = report.overdue.current.length
    ? report.overdue.current.map((entry) => `
      <div class="compact-item">
        <strong>${escapeHtml(entry.organization)} · ${escapeHtml(entry.applicationId || entry.loanId)}</strong>
        <small>반납 기한 ${escapeHtml(String(entry.dueAt).slice(0, 10))} · <span class="status-pill bad">경과 ${formatNumber.format(entry.overdueDays)}일</span></small>
      </div>
    `).join("")
    : `<div class="compact-item"><strong>연체 없음</strong><small>현재 연체 중인 반출이 없습니다.</small></div>`;

  container.innerHTML = `
    <div class="stats-grid">${metricCards}</div>
    <div class="compact-item">
      <strong>신청 상태별</strong>
      <small>${escapeHtml(statusLine)}</small>
    </div>
    <h4 class="report-section-title">품목별 대여 Top ${report.topItems.length || 10}</h4>
    <div class="compact-list">${topItems}</div>
    <h4 class="report-section-title">카테고리별 사용률</h4>
    <div class="compact-list">${categories}</div>
    <h4 class="report-section-title">품목별 파손/분실율</h4>
    <div class="compact-list">${damageItems}</div>
    <h4 class="report-section-title">현재 연체 중</h4>
    <div class="compact-list">${overdueList}</div>
  `;
}

async function loadReport(event) {
  event?.preventDefault();
  const hint = qs("#report-hint");
  const startDate = qs("#report-start-date").value;
  const endDate = qs("#report-end-date").value;
  if (startDate && endDate && startDate > endDate) {
    hint.textContent = "시작일이 종료일보다 늦을 수 없습니다.";
    hint.style.color = "var(--coral)";
    return;
  }
  try {
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    const report = await fetchJson(`/api/reports?${params.toString()}`);
    renderReport(report);
    hint.textContent = `${report.period.startDate} ~ ${report.period.endDate} (${formatNumber.format(report.period.days)}일) 기준 집계입니다.`;
    hint.style.color = "var(--muted)";
  } catch (error) {
    hint.textContent = error.message;
    hint.style.color = "var(--coral)";
  }
}

function notificationStatusTone(status) {
  if (status === "failed") return "bad";
  if (["pending", "skipped"].includes(status)) return "warn";
  return "neutral";
}

// 알림 발송 이력 패널: 최근 알림 목록 + failed/skipped 재시도 버튼(staff/admin)
function renderNotifications() {
  const container = qs("#notification-list");
  if (!container) return;
  const effectiveRole = state.session?.user?.role || state.currentRole;
  const canRetry = ["staff", "admin"].includes(effectiveRole);
  const list = state.notifications.slice(0, 20);
  container.innerHTML = list.length
    ? list.map((notification) => `
      <div class="compact-item">
        <strong>${escapeHtml(notificationTypeLabels[notification.type] || notification.type)} · ${escapeHtml(notificationChannelLabels[notification.channel] || notification.channel)}</strong>
        <small>${escapeHtml(notification.recipient)} · ${escapeHtml(notification.subject || "제목 없음")}</small>
        <small>${escapeHtml((notification.createdAt || "").replace("T", " ").slice(0, 16))}${notification.error ? ` · ${escapeHtml(notification.error)}` : ""}</small>
        <div class="form-actions">
          <span class="status-pill ${notificationStatusTone(notification.status)}">${escapeHtml(notificationStatusLabels[notification.status] || notification.status)}</span>
          ${canRetry && ["failed", "skipped"].includes(notification.status)
            ? `<button class="small-action" type="button" data-notification-retry="${escapeHtml(notification.id)}">재시도</button>`
            : ""}
        </div>
      </div>
    `).join("")
    : `<div class="compact-item"><strong>알림 없음</strong><small>승인/반출/반납 등 상태 전이 시 알림이 큐에 쌓입니다.</small></div>`;
}

async function retryNotification(notificationId) {
  try {
    await fetchJson(`/api/notifications/${encodeURIComponent(notificationId)}/retry`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await loadData();
  } catch (error) {
    alert(error.message);
  }
}

// 라벨용 실제 QR SVG 생성. qrValue는 서버가 만드는 값이지만,
// 라이브러리 미로드 등 예외 상황에서는 기존 자리 표시자로 폴백한다.
function labelQrMarkup(label) {
  if (typeof qrcode === "function") {
    try {
      const qr = qrcode(0, "M"); // typeNumber 0 = 데이터 길이에 맞춰 자동 크기
      qr.addData(label.qrValue);
      qr.make();
      const svg = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
      return `<div class="label-qr" aria-hidden="true">${svg}</div>`;
    } catch (error) {
      console.error("QR 생성 실패:", label.qrValue, error);
    }
  }
  return `<div class="fake-qr" aria-hidden="true">${escapeHtml(label.code)}</div>`;
}

function renderLabels() {
  qs("#label-grid").innerHTML = state.labels.slice(0, 24).map((label) => `
    <div class="label-card">
      ${labelQrMarkup(label)}
      <strong>${escapeHtml(label.text)}</strong>
      <span>${escapeHtml(label.name)}</span>
      <small>${escapeHtml(label.qrValue)}</small>
    </div>
  `).join("");
}

// ---------------------------------------------------------------------------
// QR 스캔 (모바일 카메라 + BarcodeDetector, 미지원 시 수동 입력 폴백)
// ---------------------------------------------------------------------------

// QR 값 파싱 규칙:
// 1) "atc-equipment:{itemId}:{code}" — buildLabels가 만드는 표준 형식
// 2) URL 형식 — ?code= / ?item= 쿼리 또는 마지막 경로 조각을 코드로 간주
// 3) 그 외 — 입력값 전체를 품목 코드/ID로 간주 (수동 입력 대응)
function parseScanValue(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.toLowerCase().startsWith("atc-equipment:")) {
    const parts = value.split(":");
    return { keys: [parts[1], parts[2]].map((part) => (part || "").trim()).filter(Boolean), raw: value };
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const codeParam = url.searchParams.get("code") || url.searchParams.get("item");
      const lastSegment = url.pathname.split("/").filter(Boolean).pop() || "";
      return { keys: [codeParam, lastSegment].filter(Boolean), raw: value };
    } catch {
      // URL 파싱 실패 시 아래 일반 처리로 넘어간다.
    }
  }
  return { keys: [value], raw: value };
}

// 품목 ID는 소문자(r01), 코드는 대문자(R01)로 저장되므로 대소문자를 보정해 찾는다.
function findItemByScan(parsed) {
  if (!parsed) return null;
  for (const key of parsed.keys) {
    const found = state.inventory.find((item) =>
      item.id === key || item.code === key ||
      item.id === key.toLowerCase() || item.code === key.toUpperCase());
    if (found) return found;
  }
  return null;
}

// 해당 품목이 걸린 활성 신청(반출중/검수 대기) 목록
function activeApplicationsForItem(itemId) {
  return state.applications.filter((application) =>
    ["checked_out", "returned"].includes(application.status) &&
    (application.items || []).some((line) => line.itemId === itemId));
}

function setScanHint(message, isError = false) {
  const hint = qs("#scan-hint");
  if (!hint) return;
  hint.textContent = message;
  hint.style.color = isError ? "var(--coral)" : "var(--muted)";
}

function renderScanResult(item, raw) {
  const container = qs("#scan-result");
  if (!container) return;
  if (!item) {
    container.className = "result-empty";
    container.textContent = `등록된 품목을 찾지 못했습니다. 입력값: ${raw}`;
    return;
  }

  const effectiveRole = state.session?.user?.role || state.currentRole;
  const canInspect = ["staff", "admin"].includes(effectiveRole);
  const occupied = state.reservations
    .filter((reservation) => reservation.itemId === item.id &&
      ["tentative", "confirmed", "checked_out"].includes(reservation.status))
    .reduce((sum, reservation) => sum + reservation.quantity, 0);
  const actives = activeApplicationsForItem(item.id);

  container.className = "result-stack";
  container.innerHTML = `
    <div class="compact-item scan-item-card">
      <strong>${escapeHtml(item.code)} ${escapeHtml(item.name)}</strong>
      <small>분류 ${escapeHtml(item.category)} · 단위 ${escapeHtml(item.unit)}</small>
      <small>총 ${formatNumber.format(item.totalQuantity)}${escapeHtml(item.unit)} · 대여 기준 ${formatNumber.format(item.rentableQuantity)}${escapeHtml(item.unit)} · 제외 ${formatNumber.format(item.unavailableQuantity)}${escapeHtml(item.unit)} · 현재 점유 ${formatNumber.format(occupied)}${escapeHtml(item.unit)}</small>
      <small>${escapeHtml(item.notes || "비고 없음")}</small>
      <div class="form-actions">
        <button class="small-action" type="button" data-scan-inventory="${escapeHtml(item.code)}">재고 보기</button>
      </div>
    </div>
    ${actives.length
      ? actives.map((application) => `
        <div class="compact-item">
          <strong>${escapeHtml(application.organization)} · ${escapeHtml(application.id)}</strong>
          <small>${application.startDate} ~ ${application.endDate} · ${escapeHtml(applicationItemsText(application))}</small>
          <div class="form-actions">
            <span class="status-pill ${statusTone(application.status)}">${applicationStatusLabel(application.status)}</span>
            ${canInspect
              ? `<button class="small-action" type="button" data-scan-inspect="${escapeHtml(application.id)}" data-scan-item="${escapeHtml(item.id)}">검수 폼으로</button>`
              : ""}
          </div>
        </div>
      `).join("")
      : `<div class="compact-item"><strong>활성 신청 없음</strong><small>이 품목이 걸린 반출중/검수 대기 신청이 없습니다.</small></div>`}
  `;
}

function handleScanValue(raw) {
  const parsed = parseScanValue(raw);
  if (!parsed) {
    setScanHint("빈 값은 조회할 수 없습니다. 품목 코드를 입력하세요.", true);
    return;
  }
  const item = findItemByScan(parsed);
  renderScanResult(item, parsed.raw);
  setScanHint(item
    ? `${item.code} ${item.name} 품목을 찾았습니다.`
    : "품목을 찾지 못했습니다. 코드 표기를 확인해 주세요.", !item);
}

function stopScan() {
  if (state.scanTimer) {
    clearInterval(state.scanTimer);
    state.scanTimer = null;
  }
  if (state.scanStream) {
    state.scanStream.getTracks().forEach((track) => track.stop());
    state.scanStream = null;
  }
  const video = qs("#scan-video");
  if (video) {
    video.pause();
    video.srcObject = null;
  }
  const start = qs("#scan-start");
  const stop = qs("#scan-stop");
  const overlay = qs("#scan-overlay");
  if (start) start.disabled = false;
  if (stop) stop.disabled = true;
  if (overlay) overlay.hidden = false;
}

// 주기(300ms)마다 비디오 프레임에서 QR을 찾는다. 인식 시 진동 + 정지 + 결과 표시.
async function scanTick() {
  const video = qs("#scan-video");
  if (!state.scanDetector || !video || video.readyState < 2) return;
  try {
    const codes = await state.scanDetector.detect(video);
    const value = codes?.[0]?.rawValue;
    if (!value) return;
    if (navigator.vibrate) navigator.vibrate(150);
    stopScan();
    handleScanValue(value);
  } catch {
    // 개별 프레임 인식 실패는 무시하고 다음 주기에 재시도한다.
  }
}

function scanErrorMessage(error) {
  if (error?.name === "NotAllowedError") {
    return "카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라 권한을 허용한 뒤 다시 시도하세요.";
  }
  if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") {
    return "사용 가능한 카메라를 찾을 수 없습니다. 아래 수동 코드 입력을 사용하세요.";
  }
  if (error?.name === "NotReadableError") {
    return "카메라를 다른 앱이 사용 중입니다. 다른 앱을 종료한 뒤 다시 시도하세요.";
  }
  return `카메라를 시작하지 못했습니다: ${error?.message || error}`;
}

async function startScan() {
  if (state.scanStream) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setScanHint("카메라 접근은 HTTPS(또는 localhost)에서만 동작합니다. 아래 수동 코드 입력을 사용하세요.", true);
    return;
  }
  if (!state.scanDetector) {
    setScanHint("이 브라우저는 QR 자동 인식(BarcodeDetector)을 지원하지 않습니다. iOS Safari 등에서는 아래 수동 코드 입력을 사용하세요.", true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    state.scanStream = stream;
    const video = qs("#scan-video");
    video.srcObject = stream;
    await video.play();
    qs("#scan-start").disabled = true;
    qs("#scan-stop").disabled = false;
    qs("#scan-overlay").hidden = true;
    state.scanTimer = setInterval(scanTick, 300);
    setScanHint("QR 코드를 카메라 중앙에 맞춰 주세요.");
  } catch (error) {
    stopScan();
    setScanHint(scanErrorMessage(error), true);
  }
}

// 페이지 로드 시 BarcodeDetector(qr_code) 지원 여부를 확인해 배지와 안내를 갱신한다.
async function initScanSupport() {
  let supported = false;
  if ("BarcodeDetector" in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        state.scanDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
        supported = true;
      }
    } catch {
      supported = false;
    }
  }
  const pill = qs("#scan-support");
  if (pill) {
    pill.textContent = supported ? "카메라 스캔 지원" : "수동 입력 모드";
    pill.classList.toggle("warn", !supported);
  }
  if (!supported) {
    setScanHint("이 브라우저는 QR 자동 인식(BarcodeDetector)을 지원하지 않습니다. 아래 수동 코드 입력을 사용하세요.", true);
  }
}

function renderAiResult(result) {
  state.currentDraft = result.draft;
  qs("#ai-mode").textContent = result.mode === "gemini" ? "Gemini" : "로컬 파서";
  qs("#submit-draft").disabled = !result.draft || result.status !== "available";

  const rows = result.availability.map((entry) => `
    <div class="availability-row ${entry.possible ? "" : "bad"}">
      <div>
        <strong>${escapeHtml(entry.item.code)} ${escapeHtml(entry.item.name)}</strong>
        <span>요청 ${formatNumber.format(entry.requestedQuantity)}${escapeHtml(entry.item.unit)} · 가능 ${formatNumber.format(entry.availableQuantity)}${escapeHtml(entry.item.unit)} · 점유 ${formatNumber.format(entry.occupiedQuantity)}${escapeHtml(entry.item.unit)}</span>
      </div>
      <span class="status-pill ${entry.possible ? "neutral" : "warn"}">${entry.possible ? "가능" : "조정"}</span>
    </div>
  `).join("");

  const conflicts = result.availability
    .flatMap((entry) => entry.conflicts.map((reservation) => {
      const item = itemById(reservation.itemId);
      return `${item?.name || reservation.itemId} ${reservation.quantity}${item?.unit || ""} ${reservation.startDate}~${reservation.endDate}`;
    }));

  qs("#ai-result").className = "result-stack";
  qs("#ai-result").innerHTML = `
    <div class="result-message">
      <strong>${escapeHtml(result.message)}</strong>
      ${result.warning ? `<small>${escapeHtml(result.warning)}</small>` : ""}
    </div>
    <div class="compact-item">
      <strong>${escapeHtml(result.draft.organization)} · ${escapeHtml(result.draft.applicant)}</strong>
      <small>${escapeHtml(result.draft.purpose)} · ${result.draft.startDate} ~ ${result.draft.endDate}</small>
    </div>
    ${rows || `<div class="compact-item"><strong>품목 미확정</strong><small>교구명을 다시 입력하세요.</small></div>`}
    ${conflicts.length ? `<div class="compact-item"><strong>겹치는 예약</strong><small>${escapeHtml(conflicts.join(" / "))}</small></div>` : ""}
  `;
}

async function handleAiSubmit(event) {
  event.preventDefault();
  const prompt = qs("#prompt").value.trim();
  if (!prompt) return;

  qs("#ai-result").className = "result-empty";
  qs("#ai-result").textContent = "예약 데이터를 확인하고 있습니다.";
  qs("#submit-draft").disabled = true;

  try {
    const result = await fetchJson("/api/ai/request", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        startDate: qs("#ai-start-date").value,
        endDate: qs("#ai-end-date").value
      })
    });
    renderAiResult(result);
  } catch (error) {
    qs("#ai-result").className = "result-empty";
    qs("#ai-result").textContent = error.message;
  }
}

async function submitDraft() {
  if (!state.currentDraft) return;
  const payload = await fetchJson("/api/applications", {
    method: "POST",
    body: JSON.stringify({ draft: state.currentDraft })
  });
  state.currentDraft = null;
  qs("#submit-draft").disabled = true;
  await loadData();
  switchView("operations");
  return payload;
}

async function handleApplicationAction(action, applicationId) {
  const application = state.applications.find((entry) => entry.id === applicationId);
  if (!application) return;
  if (action === "inspect") {
    prefillReturnFromApplication(application);
    return;
  }

  try {
    await fetchJson(`/api/applications/${encodeURIComponent(applicationId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ memo: `${applicationStatusLabel(application.status)}에서 ${action} 처리` })
    });
    await loadData();
    const updated = state.applications.find((entry) => entry.id === applicationId);
    if (action === "return" && updated) prefillReturnFromApplication(updated);
  } catch (error) {
    alert(error.message);
  }
}

// 신청의 품목 하나를 검수 폼에 채운다. itemId를 넘기지 않으면 첫 미검수 품목을 고른다.
function prefillReturnFromApplication(application, itemId = null) {
  const inspected = inspectedItemIdsFor(application.id);
  const target = itemId
    ? application.items.find((line) => line.itemId === itemId)
    : application.items.find((line) => !inspected.has(line.itemId)) || application.items[0];
  const loan = loanByApplication(application.id);
  state.activeReturnApplicationId = application.id;
  state.activeReturnLoanId = loan?.id || null;
  renderReturnProgress();
  if (!target) return;
  const quantity = Number(target.quantity || target.requestedQuantity || 1);
  const item = itemById(target.itemId);
  qs("#return-item").value = target.itemId;
  qs("#return-organization").value = application.organization;
  qs("#return-checked-out").value = quantity;
  qs("#return-normal").value = quantity;
  qs("#return-damaged").value = 0;
  qs("#return-repair").value = 0;
  qs("#return-lost").value = 0;
  qs("#return-note").value = `${application.id} ${item?.name || target.itemId} 반납 검수`;
  updateReturnHint();
  switchView("operations");
}

async function submitReturnInspection(event) {
  event.preventDefault();
  const payload = {
    applicationId: state.activeReturnApplicationId,
    loanId: state.activeReturnLoanId,
    itemId: qs("#return-item").value,
    organization: qs("#return-organization").value.trim(),
    checkedOutQuantity: Number(qs("#return-checked-out").value || 0),
    normalQuantity: Number(qs("#return-normal").value || 0),
    damagedQuantity: Number(qs("#return-damaged").value || 0),
    repairQuantity: Number(qs("#return-repair").value || 0),
    lostQuantity: Number(qs("#return-lost").value || 0),
    note: qs("#return-note").value.trim()
  };

  try {
    await fetchJson("/api/returns/inspect", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    await loadData();
    const application = activeReturnApplication();
    if (application && application.status === "returned") {
      // 아직 검수 대기 품목이 남음: 다음 품목을 폼에 채운다.
      prefillReturnFromApplication(application);
    } else {
      // 전 품목 검수 완료(신청 종결) 또는 독립 검수: 진행 목록을 정리한다.
      state.activeReturnApplicationId = null;
      state.activeReturnLoanId = null;
      renderReturnProgress();
    }
  } catch (error) {
    alert(error.message);
  }
}

function clearMemberForm() {
  state.editingMemberId = null;
  qs("#member-id").value = "";
  qs("#member-name").value = "";
  qs("#member-email").value = "";
  qs("#member-role").value = "applicant";
  qs("#member-status").value = "active";
  qs("#member-erp-id").value = "";
  qs("#member-phone").value = "";
  qs("#member-memo").value = "";
  if (state.organizations[0]) qs("#member-organization").value = state.organizations[0].id;
  qs("#member-form-hint").textContent = "관리자 권한에서 저장할 수 있습니다.";
  qs("#member-form-hint").style.color = "var(--muted)";
}

function editMember(memberId) {
  const member = state.members.find((entry) => entry.id === memberId);
  if (!member) return;
  state.editingMemberId = member.id;
  qs("#member-id").value = member.id;
  qs("#member-name").value = member.name;
  qs("#member-email").value = member.email;
  qs("#member-organization").value = member.organizationId || "";
  qs("#member-role").value = member.role;
  qs("#member-status").value = member.status;
  qs("#member-erp-id").value = member.erpUserId || "";
  qs("#member-phone").value = member.phone || "";
  qs("#member-memo").value = member.memo || "";
  qs("#member-form-hint").textContent = `${member.email} 수정 중`;
  qs("#member-form-hint").style.color = "var(--muted)";
  switchView("members");
}

async function submitMemberForm(event) {
  event.preventDefault();
  const payload = {
    name: qs("#member-name").value,
    email: qs("#member-email").value,
    organizationId: qs("#member-organization").value,
    role: qs("#member-role").value,
    status: qs("#member-status").value,
    erpUserId: qs("#member-erp-id").value,
    phone: qs("#member-phone").value,
    memo: qs("#member-memo").value
  };

  try {
    const url = state.editingMemberId
      ? `/api/members/${encodeURIComponent(state.editingMemberId)}`
      : "/api/members";
    await fetchJson(url, {
      method: state.editingMemberId ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    clearMemberForm();
    await loadData();
  } catch (error) {
    qs("#member-form-hint").textContent = error.message;
    qs("#member-form-hint").style.color = "var(--coral)";
  }
}

function clearOrganizationForm() {
  state.editingOrganizationId = null;
  qs("#organization-id").value = "";
  qs("#organization-name").value = "";
  qs("#organization-type").value = "school";
  qs("#organization-status").value = "active";
  qs("#organization-manager-email").value = "";
  qs("#organization-contact-email").value = "";
  qs("#organization-notes").value = "";
  qs("#organization-form-hint").textContent = "회원의 소속 선택지로 사용됩니다.";
  qs("#organization-form-hint").style.color = "var(--muted)";
}

function editOrganization(organizationId) {
  const organization = organizationById(organizationId);
  if (!organization) return;
  state.editingOrganizationId = organization.id;
  qs("#organization-id").value = organization.id;
  qs("#organization-name").value = organization.name;
  qs("#organization-type").value = organization.type;
  qs("#organization-status").value = organization.status;
  qs("#organization-manager-email").value = organization.managerEmail || "";
  qs("#organization-contact-email").value = organization.contactEmail || "";
  qs("#organization-notes").value = organization.notes || "";
  qs("#organization-form-hint").textContent = `${organization.name} 수정 중`;
  qs("#organization-form-hint").style.color = "var(--muted)";
  switchView("members");
}

async function submitOrganizationForm(event) {
  event.preventDefault();
  const payload = {
    name: qs("#organization-name").value,
    type: qs("#organization-type").value,
    status: qs("#organization-status").value,
    managerEmail: qs("#organization-manager-email").value,
    contactEmail: qs("#organization-contact-email").value,
    notes: qs("#organization-notes").value
  };

  try {
    const url = state.editingOrganizationId
      ? `/api/organizations/${encodeURIComponent(state.editingOrganizationId)}`
      : "/api/organizations";
    await fetchJson(url, {
      method: state.editingOrganizationId ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    clearOrganizationForm();
    await loadData();
  } catch (error) {
    qs("#organization-form-hint").textContent = error.message;
    qs("#organization-form-hint").style.color = "var(--coral)";
  }
}

function clearInventoryForm() {
  state.editingItemId = null;
  qs("#inventory-id").value = "";
  qs("#item-code").value = "";
  qs("#item-name").value = "";
  qs("#item-category").value = "";
  qs("#item-unit").value = "개";
  qs("#item-total").value = 0;
  qs("#item-unavailable").value = 0;
  qs("#item-rentable").value = 0;
  qs("#item-unit-type").value = "quantity";
  qs("#item-notes").value = "";
  qs("#inventory-form-hint").textContent = "관리자 권한에서 저장할 수 있습니다.";
}

function editInventoryItem(itemId) {
  const item = itemById(itemId);
  if (!item) return;
  state.editingItemId = item.id;
  qs("#inventory-id").value = item.id;
  qs("#item-code").value = item.code;
  qs("#item-name").value = item.name;
  qs("#item-category").value = item.category;
  qs("#item-unit").value = item.unit;
  qs("#item-total").value = item.totalQuantity;
  qs("#item-unavailable").value = item.unavailableQuantity;
  qs("#item-rentable").value = item.rentableQuantity;
  qs("#item-unit-type").value = item.unitType;
  qs("#item-notes").value = item.notes;
  qs("#inventory-form-hint").textContent = `${item.code} 수정 중`;
  switchView("inventory");
}

async function submitInventoryForm(event) {
  event.preventDefault();
  const payload = {
    code: qs("#item-code").value,
    name: qs("#item-name").value,
    category: qs("#item-category").value,
    unit: qs("#item-unit").value,
    totalQuantity: Number(qs("#item-total").value || 0),
    unavailableQuantity: Number(qs("#item-unavailable").value || 0),
    rentableQuantity: Number(qs("#item-rentable").value || 0),
    unitType: qs("#item-unit-type").value,
    notes: qs("#item-notes").value
  };

  try {
    const url = state.editingItemId
      ? `/api/inventory/${encodeURIComponent(state.editingItemId)}`
      : "/api/inventory";
    await fetchJson(url, {
      method: state.editingItemId ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    clearInventoryForm();
    await loadData();
  } catch (error) {
    qs("#inventory-form-hint").textContent = error.message;
    qs("#inventory-form-hint").style.color = "var(--coral)";
  }
}

// ---------------------------------------------------------------------------
// 엑셀(.xlsx/.xls) 업로드 → CSV 미리보기 변환 (SheetJS는 필요 시점에 동적 로드)
// ---------------------------------------------------------------------------

// CSV import가 인식하는 시스템 필드 키 (영문 헤더는 그대로 허용)
const IMPORT_FIELD_KEYS = [
  "code", "name", "category", "totalQuantity", "unavailableQuantity",
  "rentableQuantity", "unit", "unitType", "notes"
];

// 한국어 헤더 → 시스템 필드 자동 매핑 (공백 제거 후 비교)
const IMPORT_HEADER_ALIASES = {
  "코드": "code",
  "품목코드": "code",
  "품목명": "name",
  "품명": "name",
  "분류": "category",
  "카테고리": "category",
  "총수량": "totalQuantity",
  "보유수량": "totalQuantity",
  "제외": "unavailableQuantity",
  "대여제외": "unavailableQuantity",
  "제외수량": "unavailableQuantity",
  "대여기준": "rentableQuantity",
  "대여가능": "rentableQuantity",
  "대여가능수량": "rentableQuantity",
  "단위": "unit",
  "추적방식": "unitType",
  "비고": "notes",
  "메모": "notes"
};

// 헤더 문자열 → 필드 키 (매핑 실패 시 null)
function mapImportHeader(header) {
  const text = String(header ?? "").trim();
  if (!text) return null;
  const exact = IMPORT_FIELD_KEYS.find((key) => key.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  return IMPORT_HEADER_ALIASES[text.replace(/\s+/g, "")] || null;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

let xlsxLoadPromise = null;

// SheetJS를 교구 목록 화면 첫 진입 시점에만 로드해 초기 로딩을 가볍게 유지한다.
function ensureXlsxLoaded() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxLoadPromise) {
    xlsxLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/xlsx.full.min.js";
      script.onload = () => resolve(window.XLSX);
      script.onerror = () => {
        xlsxLoadPromise = null;
        script.remove();
        reject(new Error("엑셀 파서(xlsx) 스크립트를 불러오지 못했습니다."));
      };
      document.head.appendChild(script);
    });
  }
  return xlsxLoadPromise;
}

function setExcelHint(message, isError = false) {
  const hint = qs("#excel-hint");
  if (!hint) return;
  hint.textContent = message;
  hint.style.color = isError ? "var(--coral)" : "var(--muted)";
}

// 시트 데이터(행 배열)를 CSV 텍스트로 변환. 매핑 실패 컬럼은 무시하고 목록으로 알려준다.
function sheetRowsToCsv(rows) {
  const headerIndex = rows.findIndex((row) => (row || []).some((cell) => String(cell ?? "").trim()));
  if (headerIndex < 0) throw new Error("시트에 데이터가 없습니다.");

  const rawHeaders = rows[headerIndex].map((cell) => String(cell ?? "").trim());
  const seen = new Set();
  const ignored = [];
  // 각 컬럼 위치 → 필드 키 (같은 필드로 중복 매핑되면 첫 컬럼만 사용)
  const columnFields = rawHeaders.map((header) => {
    const field = mapImportHeader(header);
    if (!field) {
      if (header) ignored.push(header);
      return null;
    }
    if (seen.has(field)) {
      ignored.push(`${header}(중복)`);
      return null;
    }
    seen.add(field);
    return field;
  });

  if (!seen.has("code") || !seen.has("name")) {
    throw new Error("코드/품목명 컬럼을 찾지 못했습니다. 헤더에 '코드'와 '품목명'(또는 code, name)이 필요합니다.");
  }

  const fields = columnFields.filter(Boolean);
  const lines = [fields.join(",")];
  for (const row of rows.slice(headerIndex + 1)) {
    const cells = row || [];
    if (!cells.some((cell) => String(cell ?? "").trim())) continue;
    const values = [];
    columnFields.forEach((field, index) => {
      if (field) values.push(csvEscape(String(cells[index] ?? "").trim()));
    });
    lines.push(values.join(","));
  }
  if (lines.length < 2) throw new Error("헤더 아래에 반영할 데이터 행이 없습니다.");
  return { csv: lines.join("\n"), rowCount: lines.length - 1, ignored };
}

// 파일 선택 시: xlsx/xls → SheetJS 파싱 후 CSV 변환, csv → 텍스트 그대로 미리보기에 채운다.
async function handleExcelFile(event) {
  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (/\.csv$/i.test(file.name)) {
      qs("#csv-input").value = await file.text();
      setExcelHint(`${file.name} 내용을 미리보기에 채웠습니다. 확인 후 "일괄 반영"을 누르세요.`);
      return;
    }
    setExcelHint(`${file.name} 파일을 읽는 중입니다.`);
    const XLSX = await ensureXlsxLoaded();
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("시트를 찾을 수 없습니다.");
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: "" });
    const { csv, rowCount, ignored } = sheetRowsToCsv(rows);
    qs("#csv-input").value = csv;
    setExcelHint([
      `${file.name} (시트: ${sheetName}) → ${formatNumber.format(rowCount)}행을 변환했습니다.`,
      ignored.length ? `매핑되지 않아 무시한 컬럼: ${ignored.join(", ")}.` : "",
      `미리보기 확인 후 "일괄 반영"을 누르세요.`
    ].filter(Boolean).join(" "));
  } catch (error) {
    setExcelHint(`파일 처리 실패: ${error.message}`, true);
  } finally {
    input.value = ""; // 같은 파일을 다시 선택해도 change 이벤트가 오도록 초기화
  }
}

async function submitCsv(event) {
  event.preventDefault();
  try {
    const result = await fetchJson("/api/inventory/import", {
      method: "POST",
      body: JSON.stringify({ csv: qs("#csv-input").value })
    });
    qs("#csv-hint").textContent = `${formatNumber.format(result.imported.length)}개 품목을 반영했습니다.`;
    await loadData();
  } catch (error) {
    qs("#csv-hint").textContent = error.message;
    qs("#csv-hint").style.color = "var(--coral)";
  }
}

function renderAll() {
  updateSessionPanel();
  renderMetrics();
  renderPendingList();
  renderIssueList();
  renderCategoryFilters();
  renderInventory();
  renderReservations();
  renderApplications();
  renderMemberSummary();
  renderMemberOptions();
  renderMembers();
  renderOrganizations();
  renderReturnItemOptions();
  renderReturnProgress();
  renderReturnInspections();
  renderRepairTickets();
  renderStats();
  updateReportPanelVisibility();
  renderNotifications();
  renderLabels();
  updateReturnHint();
}

async function loadData() {
  const [health, session] = await Promise.all([
    fetchJson("/api/health"),
    fetchJson("/api/session")
  ]);
  state.session = session;
  qs("#gemini-badge").textContent = health.geminiConfigured ? `Gemini ${health.model}` : "로컬 AI 모드";
  qs("#gemini-badge").classList.toggle("warn", !health.geminiConfigured);

  if (session.authMode === "supabase" && !session.authenticated) {
    renderLoginRequired(session);
    return;
  }

  const effectiveRole = state.session?.user?.role || state.currentRole;
  const memberRequest = effectiveRole === "applicant"
    ? Promise.resolve({ members: [], organizations: [], summary: null })
    : fetchJson("/api/members");
  // 수리 티켓은 staff/admin/auditor만 조회 가능
  const repairRequest = effectiveRole === "applicant"
    ? Promise.resolve({ repairTickets: [] })
    : fetchJson("/api/repairs");
  // 알림 발송 이력도 staff/admin/auditor만 조회 가능
  const notificationRequest = effectiveRole === "applicant"
    ? Promise.resolve({ notifications: [] })
    : fetchJson("/api/notifications");
  const [inventoryData, applicationData, returnData, repairData, memberData, statsData, labelData, notificationData] = await Promise.all([
    fetchJson("/api/inventory"),
    fetchJson("/api/applications"),
    fetchJson("/api/returns"),
    repairRequest,
    memberRequest,
    fetchJson("/api/stats"),
    fetchJson("/api/labels?limit=80"),
    notificationRequest
  ]);

  state.inventory = inventoryData.inventory;
  state.categories = inventoryData.categories;
  state.reservations = inventoryData.reservations;
  state.applications = applicationData.applications;
  state.loans = applicationData.loans || [];
  state.returnInspections = returnData.returnInspections;
  state.repairTickets = repairData.repairTickets || [];
  state.members = memberData.members || [];
  state.organizations = memberData.organizations || [];
  state.memberSummary = memberData.summary || null;
  state.stats = statsData;
  state.labels = labelData.labels;
  state.notifications = notificationData.notifications || [];

  renderAll();
}

document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-section]");
  if (nav) switchView(nav.dataset.section);

  const jump = event.target.closest("[data-jump]");
  if (jump) switchView(jump.dataset.jump);

  const category = event.target.closest("[data-category]");
  if (category) {
    state.currentCategory = category.dataset.category;
    renderCategoryFilters();
    renderInventory();
  }

  const appAction = event.target.closest("[data-app-action]");
  if (appAction) {
    handleApplicationAction(appAction.dataset.appAction, appAction.dataset.appId);
  }

  const returnPick = event.target.closest("[data-return-pick]");
  if (returnPick) {
    const application = activeReturnApplication();
    if (application) prefillReturnFromApplication(application, returnPick.dataset.returnPick);
  }

  const repairAction = event.target.closest("[data-repair-action]");
  if (repairAction) {
    handleRepairAction(repairAction.dataset.repairAction, repairAction.dataset.repairId);
  }

  const notificationRetry = event.target.closest("[data-notification-retry]");
  if (notificationRetry) {
    retryNotification(notificationRetry.dataset.notificationRetry);
  }

  const scanInspect = event.target.closest("[data-scan-inspect]");
  if (scanInspect) {
    const application = state.applications.find((entry) => entry.id === scanInspect.dataset.scanInspect);
    if (application) prefillReturnFromApplication(application, scanInspect.dataset.scanItem);
  }

  const scanInventory = event.target.closest("[data-scan-inventory]");
  if (scanInventory) {
    qs("#inventory-search").value = scanInventory.dataset.scanInventory;
    renderInventory();
    switchView("inventory");
  }

  const inventoryEdit = event.target.closest("[data-inventory-edit]");
  if (inventoryEdit) {
    editInventoryItem(inventoryEdit.dataset.inventoryEdit);
  }

  const memberEdit = event.target.closest("[data-member-edit]");
  if (memberEdit) {
    editMember(memberEdit.dataset.memberEdit);
  }

  const organizationEdit = event.target.closest("[data-organization-edit]");
  if (organizationEdit) {
    editOrganization(organizationEdit.dataset.organizationEdit);
  }
});

qs("#role-select").addEventListener("change", async (event) => {
  state.currentRole = event.target.value;
  localStorage.setItem("equipmentRole", state.currentRole);
  // 권한이 바뀌면 리포트를 다시 조회하도록 초기화한다 (applicant는 패널 자체가 숨겨짐).
  state.reportLoaded = false;
  const reportResult = qs("#report-result");
  if (reportResult) reportResult.innerHTML = "";
  await loadData();
});
qs("#inventory-search").addEventListener("input", renderInventory);
qs("#clear-search").addEventListener("click", () => {
  qs("#inventory-search").value = "";
  renderInventory();
});
qs("#member-search").addEventListener("input", renderMembers);
qs("#member-status-filter").addEventListener("change", (event) => {
  state.currentMemberStatus = event.target.value;
  renderMembers();
});
qs("#ai-form").addEventListener("submit", handleAiSubmit);
qs("#submit-draft").addEventListener("click", submitDraft);
qs("#return-form").addEventListener("submit", submitReturnInspection);
qs("#inventory-form").addEventListener("submit", submitInventoryForm);
qs("#inventory-form-clear").addEventListener("click", clearInventoryForm);
qs("#csv-form").addEventListener("submit", submitCsv);
qs("#excel-file").addEventListener("change", handleExcelFile);
qs("#report-form").addEventListener("submit", loadReport);
qs("#member-form").addEventListener("submit", submitMemberForm);
qs("#member-form-clear").addEventListener("click", clearMemberForm);
qs("#organization-form").addEventListener("submit", submitOrganizationForm);
qs("#organization-form-clear").addEventListener("click", clearOrganizationForm);
qs("#print-labels").addEventListener("click", () => window.print());
qs("#scan-start").addEventListener("click", startScan);
qs("#scan-stop").addEventListener("click", stopScan);
qs("#scan-manual-form").addEventListener("submit", (event) => {
  event.preventDefault();
  handleScanValue(qs("#scan-manual-input").value);
});
["#return-checked-out", "#return-normal", "#return-damaged", "#return-repair", "#return-lost"]
  .forEach((selector) => qs(selector).addEventListener("input", updateReturnHint));

qs("#role-select").value = state.currentRole;
setDefaultReportRange();
initScanSupport();
loadData().catch((error) => {
  document.body.innerHTML = `<main class="main"><section class="panel"><h1>초기화 오류</h1><p>${escapeHtml(error.message)}</p></section></main>`;
});
