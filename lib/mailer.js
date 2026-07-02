const net = require("node:net");
const tls = require("node:tls");

// 무의존성 SMTP 클라이언트.
// SMTP_HOST가 없으면 발송하지 않고 false를 반환한다 (알림 큐에는 skipped로 기록).
// 지원: SMTPS(465, 즉시 TLS) / STARTTLS(587 등) / AUTH LOGIN.
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_SECURE = String(process.env.SMTP_SECURE || "").toLowerCase(); // "smtps" | "starttls" | ""(자동)
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const SMTP_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || 15000);

function mailerConfigured() {
  return Boolean(SMTP_HOST && SMTP_FROM);
}

function useImplicitTls() {
  if (SMTP_SECURE === "smtps") return true;
  if (SMTP_SECURE === "starttls") return false;
  return SMTP_PORT === 465;
}

// 한 줄 명령을 보내고 응답 코드를 기다리는 작은 상태 기계.
function createSmtpSession(socket) {
  let buffer = "";
  let pending = null;

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    // 멀티라인 응답(250-... / 250 ...)의 마지막 줄까지 기다린다.
    const lines = buffer.split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last || !/^\d{3} /.test(last)) return;
    const code = Number(last.slice(0, 3));
    const response = buffer;
    buffer = "";
    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve({ code, response });
    }
  });

  return {
    waitReply() {
      return new Promise((resolve, reject) => {
        pending = { resolve };
        socket.once("error", reject);
      });
    },
    async command(line, expectedCodes) {
      socket.write(`${line}\r\n`);
      const reply = await this.waitReply();
      if (expectedCodes && !expectedCodes.includes(reply.code)) {
        const label = line.startsWith("AUTH") || /^[A-Za-z0-9+/=]+$/.test(line) ? "(자격 증명)" : line;
        throw new Error(`SMTP ${label} 실패: ${reply.response.trim().slice(0, 200)}`);
      }
      return reply;
    }
  };
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    const socket = useImplicitTls()
      ? tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST }, () => resolve(socket))
      : net.connect({ host: SMTP_HOST, port: SMTP_PORT }, () => resolve(socket));
    socket.setTimeout(SMTP_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error("SMTP 연결 시간 초과"));
    });
    socket.once("error", onError);
  });
}

function upgradeToTls(socket) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: SMTP_HOST }, () => resolve(secured));
    secured.setTimeout(SMTP_TIMEOUT_MS, () => {
      secured.destroy();
      reject(new Error("SMTP TLS 승격 시간 초과"));
    });
    secured.once("error", reject);
  });
}

function encodeHeaderText(value) {
  // 한국어 제목을 위한 RFC 2047 base64 인코딩.
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildMessage({ to, subject, text }) {
  const body = String(text || "").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  return [
    `From: ${SMTP_FROM}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderText(subject || "(제목 없음)")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    "."
  ].join("\r\n");
}

// 반환: { sent: boolean, detail: string }
// 미설정이면 { sent: false, detail: "smtp-not-configured" } — 오류로 취급하지 않는다.
async function sendMail({ to, subject, text }) {
  if (!mailerConfigured()) {
    return { sent: false, detail: "smtp-not-configured" };
  }
  if (!to) {
    return { sent: false, detail: "수신자 이메일 없음" };
  }

  let socket = await connectSocket();
  let session = createSmtpSession(socket);
  try {
    await session.waitReply(); // 220 배너

    let ehlo = await session.command("EHLO equipment-manager", [250]);
    if (!useImplicitTls() && /STARTTLS/i.test(ehlo.response)) {
      await session.command("STARTTLS", [220]);
      socket = await upgradeToTls(socket);
      session = createSmtpSession(socket);
      ehlo = await session.command("EHLO equipment-manager", [250]);
    }

    if (SMTP_USER && SMTP_PASS) {
      await session.command("AUTH LOGIN", [334]);
      await session.command(Buffer.from(SMTP_USER, "utf8").toString("base64"), [334]);
      await session.command(Buffer.from(SMTP_PASS, "utf8").toString("base64"), [235]);
    }

    const fromAddress = SMTP_FROM.match(/<([^>]+)>/)?.[1] || SMTP_FROM;
    await session.command(`MAIL FROM:<${fromAddress}>`, [250]);
    await session.command(`RCPT TO:<${to}>`, [250, 251]);
    await session.command("DATA", [354]);
    await session.command(buildMessage({ to, subject, text }), [250]);
    await session.command("QUIT", [221]).catch(() => {});
    return { sent: true, detail: "ok" };
  } finally {
    socket.destroy();
  }
}

module.exports = { mailerConfigured, sendMail };
