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

module.exports = {
  dateOnly,
  isoDateTime,
  parseJsonValue,
  mergeById,
  uniqueValues,
  overlaps,
  formatDate,
  addDays,
  normalizeDateInput,
  addHours,
  isSsemEmail,
  normalizeEmail,
  cleanText,
  choice,
  parseCsvLine,
  parseInventoryCsv
};
