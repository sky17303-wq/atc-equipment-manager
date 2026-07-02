const { GEMINI_MODEL } = require("./config");
const { addDays, formatDate, normalizeDateInput } = require("./utils");
const { calculateAvailability } = require("./domain");

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

module.exports = {
  findItems,
  inferQuantity,
  inferPurpose,
  inferOrganization,
  inferApplicant,
  inferDateRange,
  suggestRobotBundle,
  localParse,
  stripJsonFence,
  parseWithGemini,
  buildAiResponse
};
