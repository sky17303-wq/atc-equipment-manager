const { randomUUID } = require("node:crypto");

const { sendJson } = require("./http-utils");
const { saveRuntimeState } = require("./storage");
const { requireRole } = require("./auth");
const { upsertRuntimeEntry } = require("./domain");
const { sendMail } = require("./mailer");

// 알림 큐: 상태 전이 시 enqueue → 디스패처가 주기적으로 이메일 발송.
// 카카오 알림톡은 스텁(KAKAO_ENABLED 시 kakao 채널 엔트리만 생성, 발송기는 미구현).

const MAX_ATTEMPTS = 3;

function isTruthyEnv(value) {
  return !["", "0", "false", "off", "no"].includes(String(value || "").trim().toLowerCase());
}

function kakaoEnabled() {
  return isTruthyEnv(process.env.KAKAO_ENABLED);
}

function dispatchIntervalMs() {
  const value = Number(process.env.NOTIFY_DISPATCH_INTERVAL_MS || 60000);
  return Number.isFinite(value) && value >= 1000 ? value : 60000;
}

function dueSoonDays() {
  const value = Number(process.env.NOTIFY_DUE_SOON_DAYS || 1);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

function buildNotificationEntry({ type, channel, recipient, subject, body, relatedId, dedupeKey }) {
  const now = new Date().toISOString();
  return {
    id: `ntf-${randomUUID().slice(0, 8)}`,
    type,
    channel,
    recipient: String(recipient || ""),
    subject: String(subject || ""),
    body: String(body || ""),
    status: "pending",
    relatedId: relatedId || null,
    dedupeKey: dedupeKey || null,
    attempts: 0,
    error: null,
    createdAt: now,
    sentAt: null,
    updatedAt: now
  };
}

// 알림 1건(email 채널)을 runtime 큐에 넣는다.
// dedupeKey가 있고 동일 키+채널 알림이 이미 있으면 만들지 않는다 (하루 1회 제한 등).
// options.existing: 병합된 기존 알림 목록(seed.notifications) — PostgreSQL 모드처럼
// runtime이 요청마다 비어 있는 환경에서 중복 판정에 사용한다.
function enqueueNotification(runtime, { type, recipient, subject, body, relatedId = null, dedupeKey = null }, options = {}) {
  runtime.notifications = Array.isArray(runtime.notifications) ? runtime.notifications : [];
  if (!recipient) return [];

  const known = [...(options.existing || []), ...runtime.notifications];
  const isDuplicate = (channel) =>
    Boolean(dedupeKey) && known.some((entry) => entry.dedupeKey === dedupeKey && entry.channel === channel);

  const created = [];
  if (!isDuplicate("email")) {
    const entry = buildNotificationEntry({ type, channel: "email", recipient, subject, body, relatedId, dedupeKey });
    runtime.notifications.unshift(entry);
    created.push(entry);
  }
  // 카카오 알림톡 스텁: 발송기가 없어 pending으로 남는다.
  if (kakaoEnabled() && !isDuplicate("kakao")) {
    const entry = buildNotificationEntry({ type, channel: "kakao", recipient, subject, body, relatedId, dedupeKey });
    runtime.notifications.unshift(entry);
    created.push(entry);
  }
  return created;
}

// 품목 목록을 "품목명 2개, ..." 형태의 한국어 요약으로 만든다.
function formatItemsSummary(seed, items) {
  return (items || [])
    .map((line) => {
      const item = (seed.inventory || []).find((entry) => entry.id === line.itemId || entry.code === line.itemId);
      const quantity = Number(line.quantity || line.requestedQuantity || 0);
      return `${item?.name || line.itemId} ${quantity}${item?.unit || "개"}`;
    })
    .join(", ");
}

// 반출 중 loan의 반납 기한 스윕: 기한 임박(due_soon)·기한 초과(overdue) 알림을 만든다.
// dedupeKey에 오늘 날짜를 넣어 하루 1회로 제한한다.
function sweepDueNotifications(seed, runtime) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const soonLimit = now.getTime() + dueSoonDays() * 24 * 60 * 60 * 1000;
  let created = 0;

  for (const loan of seed.loans || []) {
    if (loan.status !== "active") continue;
    if (!loan.dueAt) continue;
    const dueTime = new Date(loan.dueAt).getTime();
    if (!Number.isFinite(dueTime)) continue;

    const application = (seed.applications || []).find((entry) => entry.id === loan.applicationId);
    if (!application?.email) continue;

    let type = null;
    if (dueTime < now.getTime()) type = "application.overdue";
    else if (dueTime <= soonLimit) type = "application.due_soon";
    if (!type) continue;

    const dueDate = String(loan.dueAt).slice(0, 10);
    const subject = type === "application.overdue"
      ? "[ATC 교구] 반납 기한이 지났습니다"
      : "[ATC 교구] 반납 기한이 임박했습니다";
    const body = [
      `${application.applicant || "선생님"}님, 안녕하세요. ATC 교구 대여 안내입니다.`,
      "",
      type === "application.overdue"
        ? `반납 예정일(${dueDate})이 지났습니다. 빠른 반납을 부탁드립니다.`
        : `반납 예정일(${dueDate})이 다가오고 있습니다.`,
      `기관: ${application.organization || "미입력"}`,
      `품목: ${formatItemsSummary(seed, loan.items || application.items)}`,
      "",
      "문의: 컴퓨팅교사협회 교구 운영 담당"
    ].join("\n");

    created += enqueueNotification(runtime, {
      type,
      recipient: application.email,
      subject,
      body,
      relatedId: loan.id,
      dedupeKey: `${type}:${loan.id}:${today}`
    }, { existing: seed.notifications }).length;
  }

  return created;
}

// pending 상태의 email 알림을 실제 발송한다. kakao 채널은 건드리지 않는다.
// 반환: 상태가 바뀐 알림 엔트리 목록 (runtime.notifications에 upsert 완료 상태).
async function deliverPendingEmails(seed, runtime) {
  const changed = [];
  const pending = (seed.notifications || []).filter(
    (entry) => entry.status === "pending" && entry.channel === "email"
  );

  for (const entry of pending) {
    const next = { ...entry, updatedAt: new Date().toISOString() };
    try {
      const result = await sendMail({ to: next.recipient, subject: next.subject, text: next.body });
      if (result.sent) {
        next.status = "sent";
        next.sentAt = new Date().toISOString();
        next.error = null;
      } else if (result.detail === "smtp-not-configured") {
        // SMTP 미설정: 재시도해도 소용없으므로 skipped로 종결한다.
        next.status = "skipped";
        next.error = result.detail;
      } else {
        next.attempts = Number(next.attempts || 0) + 1;
        next.error = result.detail;
        next.status = next.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      }
    } catch (error) {
      next.attempts = Number(next.attempts || 0) + 1;
      next.error = error.message;
      next.status = next.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    }
    upsertRuntimeEntry(runtime.notifications, next);
    changed.push(next);
  }

  return changed;
}

// 디스패처 1회 실행: 기한 스윕 → pending email 발송 → 변경분 저장.
async function runNotificationDispatch() {
  // 순환 의존(state → domain, notifications → state)을 피하기 위해 지연 require.
  const { getSystemState } = require("./state");
  const { seed, runtime } = await getSystemState();
  const sweepCreated = sweepDueNotifications(seed, runtime);
  const delivered = await deliverPendingEmails(seed, runtime);
  if (sweepCreated > 0 || delivered.length > 0) {
    await saveRuntimeState(runtime);
  }
  return { sweepCreated, delivered: delivered.length };
}

// 주기 발송 시작. 타이머는 unref()로 프로세스 종료를 막지 않는다.
function startNotificationDispatcher() {
  const tick = () => {
    runNotificationDispatch().catch((error) => {
      console.error(`[notifications] 발송 처리 실패: ${error.message}`);
    });
  };
  const timer = setInterval(tick, dispatchIntervalMs());
  timer.unref();
  tick(); // 서버 기동 직후 1회 즉시 실행
  return timer;
}

// 알림 조회/재시도 API
async function handleNotificationsApi(context) {
  const { req, res, url, seed, runtime, actor } = context;

  if (req.method === "GET" && url.pathname === "/api/notifications") {
    const allowedActor = requireRole(actor, res, ["staff", "admin", "auditor"]);
    if (!allowedActor) return true;
    sendJson(res, { notifications: (seed.notifications || []).slice(0, 100) });
    return true;
  }

  const retryMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/retry$/);
  if (req.method === "POST" && retryMatch) {
    const allowedActor = requireRole(actor, res, ["staff", "admin"]);
    if (!allowedActor) return true;

    const notificationId = decodeURIComponent(retryMatch[1]);
    const existing = (seed.notifications || []).find((entry) => entry.id === notificationId);
    if (!existing) {
      sendJson(res, { error: "알림을 찾을 수 없습니다." }, 404);
      return true;
    }
    if (!["failed", "skipped"].includes(existing.status)) {
      sendJson(res, { error: "failed 또는 skipped 상태의 알림만 재시도할 수 있습니다." }, 409);
      return true;
    }

    const notification = {
      ...existing,
      status: "pending",
      attempts: 0,
      error: null,
      updatedAt: new Date().toISOString()
    };
    runtime.notifications = Array.isArray(runtime.notifications) ? runtime.notifications : [];
    upsertRuntimeEntry(runtime.notifications, notification);
    await saveRuntimeState(runtime);
    sendJson(res, { notification });
    return true;
  }

  return false;
}

module.exports = {
  enqueueNotification,
  formatItemsSummary,
  sweepDueNotifications,
  runNotificationDispatch,
  startNotificationDispatcher,
  handleNotificationsApi
};
