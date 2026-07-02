const { randomUUID } = require("node:crypto");

const { parseInventoryCsv } = require("./utils");
const { sendJson, readBody } = require("./http-utils");
const { saveRuntimeState } = require("./storage");
const { requireRole } = require("./auth");
const { addRuntimeEvent, normalizeInventoryPayload } = require("./domain");

// 교구(품목) 등록/수정/CSV 가져오기 API
async function handleInventoryApi(context) {
  const { req, res, url, seed, runtime, actor } = context;

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

module.exports = { handleInventoryApi };
