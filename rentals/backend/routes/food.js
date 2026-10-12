const express = require("express");
const crypto = require("crypto");
const defaultDatabase = require("../db/connection");
const { requireAdminSession, requireCsrf, requireRole } = require("../middleware/requireAdmin");
const { writeAudit } = require("../services/adminAuthService");
const { logFailure } = require("../utils/safeLog");

const ORDER_TRANSITIONS = Object.freeze({
  NEW: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["COMPLETED", "CANCELLED"],
  COMPLETED: [], REJECTED: [], CANCELLED: []
});
const validPhone = (value) => /^[0-9+(). -]{7,30}$/.test(String(value || "").trim());
const text = (value, max) => String(value || "").trim().slice(0, max);
function httpError(statusCode, message, code) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }
function asInteger(value, fallback = null) { const number = Number(value); return Number.isInteger(number) ? number : fallback; }
function validId(value) { const id = asInteger(value); return id && id > 0 ? id : null; }
function orderNumber() { return `THF-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`; }
function mapItem(row) { return { id: row.id, categoryId: row.category_id, name: row.name, description: row.description, priceCents: Number(row.price_cents), imageUrl: row.image_url, displayOrder: Number(row.display_order), isActive: row.is_active, isSoldOut: row.is_sold_out }; }
function mapCategory(row) { return { id: row.id, name: row.name, description: row.description, displayOrder: Number(row.display_order), isActive: row.is_active }; }
function mapOrder(row) { return { id: Number(row.id), orderNumber: row.order_number, customerName: row.customer_name, customerPhone: row.customer_phone, pickupType: row.pickup_type, pickupAt: row.pickup_at, customerNotes: row.customer_notes, status: row.status, paymentMethod: row.payment_method, paymentStatus: row.payment_status, subtotalCents: Number(row.subtotal_cents), totalCents: Number(row.total_cents), createdAt: row.created_at, updatedAt: row.updated_at }; }

async function menu(database, publicOnly) {
  const categories = await database.query(`SELECT * FROM food_categories ${publicOnly ? "WHERE is_active" : ""} ORDER BY display_order, id`);
  const items = await database.query(`SELECT * FROM food_items ${publicOnly ? "WHERE is_active" : ""} ORDER BY display_order, id`);
  const grouped = new Map(categories.rows.map((row) => [row.id, { ...mapCategory(row), items: [] }]));
  items.rows.forEach((row) => { if (grouped.has(row.category_id)) grouped.get(row.category_id).items.push(mapItem(row)); });
  return [...grouped.values()];
}

async function loadOrder(database, id) {
  const order = await database.query("SELECT * FROM food_orders WHERE id = $1", [id]);
  if (!order.rowCount) return null;
  const items = await database.query("SELECT item_name, unit_price_cents, quantity, line_total_cents FROM food_order_items WHERE food_order_id = $1 ORDER BY id", [id]);
  return { ...mapOrder(order.rows[0]), items: items.rows.map((item) => ({ itemName: item.item_name, unitPriceCents: Number(item.unit_price_cents), quantity: Number(item.quantity), lineTotalCents: Number(item.line_total_cents) })) };
}

function validateCart(body) {
  if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 30) throw httpError(400, "Select between 1 and 30 menu items.");
  const merged = new Map();
  for (const entry of body.items) {
    const itemId = asInteger(entry?.itemId); const quantity = asInteger(entry?.quantity);
    if (!itemId || !quantity || quantity < 1 || quantity > 99) throw httpError(400, "Each menu item needs a quantity from 1 to 99.");
    merged.set(itemId, (merged.get(itemId) || 0) + quantity);
  }
  if ([...merged.values()].some((quantity) => quantity > 99)) throw httpError(400, "Item quantity cannot exceed 99.");
  return [...merged.entries()].map(([itemId, quantity]) => ({ itemId, quantity }));
}

function createFoodRouter({ database = defaultDatabase } = {}) {
  const router = express.Router();
  router.get("/menu", async (_req, res) => { try { res.json({ categories: await menu(database, true) }); } catch (error) { logFailure("food.menu", error); res.status(500).json({ error: "Menu is unavailable" }); } });
  router.post("/orders", async (req, res) => {
    const name = text(req.body?.customerName, 160), phone = text(req.body?.customerPhone, 40), notes = text(req.body?.customerNotes, 1000);
    const pickupType = String(req.body?.pickupType || "").toUpperCase(); const key = text(req.get("Idempotency-Key") || req.body?.clientRequestKey, 100);
    if (!name || !validPhone(phone)) return res.status(400).json({ error: "Customer name and a valid phone number are required." });
    if (!key || !/^[A-Za-z0-9_-]{12,100}$/.test(key)) return res.status(400).json({ error: "A valid request key is required." });
    let pickupAt = null;
    if (pickupType === "SCHEDULED") { pickupAt = new Date(req.body?.pickupAt); if (Number.isNaN(pickupAt.getTime()) || pickupAt.getTime() < Date.now() + 5 * 60000 || pickupAt.getTime() > Date.now() + 30 * 86400000) return res.status(400).json({ error: "Choose a pickup time between 5 minutes and 30 days from now." }); }
    else if (pickupType !== "ASAP") return res.status(400).json({ error: "Pickup choice must be ASAP or scheduled." });
    let cart; try { cart = validateCart(req.body); } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }); }
    const client = await database.connect(); let begun = false;
    try {
      await client.query("BEGIN"); begun = true;
      const existing = await client.query("SELECT id FROM food_orders WHERE client_request_key = $1", [key]);
      if (existing.rowCount) { await client.query("COMMIT"); return res.status(200).json({ order: await loadOrder(database, existing.rows[0].id), duplicate: true }); }
      const ids = cart.map((line) => line.itemId);
      const records = await client.query("SELECT id, name, price_cents FROM food_items WHERE id = ANY($1::integer[]) AND is_active AND NOT is_sold_out FOR UPDATE", [ids]);
      if (records.rowCount !== ids.length) throw httpError(409, "One or more selected items are unavailable.", "ITEM_UNAVAILABLE");
      const byId = new Map(records.rows.map((item) => [item.id, item]));
      const lines = cart.map((line) => ({ ...line, item: byId.get(line.itemId) })); const total = lines.reduce((sum, line) => sum + Number(line.item.price_cents) * line.quantity, 0);
      const created = await client.query(`INSERT INTO food_orders (order_number, customer_name, customer_phone, pickup_type, pickup_at, customer_notes, subtotal_cents, total_cents, client_request_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) RETURNING id`, [orderNumber(), name, phone, pickupType, pickupAt, notes || null, total, key]);
      for (const line of lines) await client.query("INSERT INTO food_order_items (food_order_id, food_item_id, item_name, unit_price_cents, quantity, line_total_cents) VALUES ($1,$2,$3,$4,$5,$6)", [created.rows[0].id, line.item.id, line.item.name, line.item.price_cents, line.quantity, Number(line.item.price_cents) * line.quantity]);
      await client.query("COMMIT"); begun = false; return res.status(201).json({ order: await loadOrder(database, created.rows[0].id) });
    } catch (error) { if (begun) await client.query("ROLLBACK"); if (error.code === "23505") { const found = await database.query("SELECT id FROM food_orders WHERE client_request_key = $1", [key]); if (found.rowCount) return res.status(200).json({ order: await loadOrder(database, found.rows[0].id), duplicate: true }); } logFailure("food.order.create", error); return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Unable to submit order", ...(error.code ? { code: error.code } : {}) }); } finally { client.release(); }
  });
  return router;
}

function createAdminFoodRouter({ database = defaultDatabase } = {}) {
  const router = express.Router();
  router.get("/menu", requireAdminSession, async (_req, res) => { try { res.json({ categories: await menu(database, false) }); } catch (error) { logFailure("admin.food.menu", error); res.status(500).json({ error: "Failed to load menu" }); } });
  router.get("/orders", requireAdminSession, async (_req, res) => { try { const results = await database.query("SELECT * FROM food_orders ORDER BY created_at DESC LIMIT 300"); res.json({ orders: await Promise.all(results.rows.map((row) => loadOrder(database, row.id))) }); } catch (error) { logFailure("admin.food.orders", error); res.status(500).json({ error: "Failed to load food orders" }); } });
  router.post("/categories", requireAdminSession, requireRole("OWNER"), requireCsrf, async (req, res) => { const name = text(req.body?.name, 100); if (!name) return res.status(400).json({ error: "Category name is required" }); try { const result = await database.query("INSERT INTO food_categories (name, description, display_order) VALUES ($1,$2,$3) RETURNING *", [name, text(req.body?.description, 500) || null, Math.max(0, asInteger(req.body?.displayOrder, 0))]); await writeAudit(database, req.admin.id, "FOOD_CATEGORY_CREATE", "FOOD_CATEGORY", result.rows[0].id); res.status(201).json({ category: mapCategory(result.rows[0]) }); } catch (error) { res.status(error.code === "23505" ? 409 : 500).json({ error: error.code === "23505" ? "A category with that name already exists" : "Failed to save category" }); } });
  router.patch("/categories/:id", requireAdminSession, requireRole("OWNER"), requireCsrf, async (req, res) => { const id = validId(req.params.id), order = req.body?.displayOrder === undefined ? null : asInteger(req.body.displayOrder); if (!id || (order !== null && order < 0) || (req.body?.isActive !== undefined && typeof req.body.isActive !== "boolean") || (req.body?.name !== undefined && !text(req.body.name, 100))) return res.status(400).json({ error: "Invalid category details" }); const result = await database.query("UPDATE food_categories SET name = COALESCE($1,name), description = COALESCE($2,description), display_order = COALESCE($3,display_order), is_active = COALESCE($4,is_active), updated_at = CURRENT_TIMESTAMP WHERE id=$5 RETURNING *", [req.body?.name === undefined ? null : text(req.body.name, 100), req.body?.description === undefined ? null : text(req.body.description, 500) || null, order, typeof req.body?.isActive === "boolean" ? req.body.isActive : null, id]); if (!result.rowCount) return res.status(404).json({ error: "Category not found" }); await writeAudit(database, req.admin.id, "FOOD_CATEGORY_UPDATE", "FOOD_CATEGORY", id); res.json({ category: mapCategory(result.rows[0]) }); });
  router.post("/items", requireAdminSession, requireRole("OWNER"), requireCsrf, async (req, res) => { const name = text(req.body?.name, 140), categoryId = asInteger(req.body?.categoryId), price = asInteger(req.body?.priceCents); if (!name || !categoryId || price === null || price < 0 || price > 1000000) return res.status(400).json({ error: "Category, name, and a valid price are required" }); try { const result = await database.query("INSERT INTO food_items (category_id,name,description,price_cents,image_url,display_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [categoryId, name, text(req.body?.description, 1000) || null, price, text(req.body?.imageUrl, 1024) || null, Math.max(0, asInteger(req.body?.displayOrder, 0))]); await writeAudit(database, req.admin.id, "FOOD_ITEM_CREATE", "FOOD_ITEM", result.rows[0].id); res.status(201).json({ item: mapItem(result.rows[0]) }); } catch (error) { res.status(error.code === "23503" ? 400 : 500).json({ error: error.code === "23503" ? "Category not found" : "Failed to save menu item" }); } });
  router.patch("/items/:id", requireAdminSession, requireCsrf, async (req, res) => { const owner = req.admin.role === "OWNER", id = validId(req.params.id); const soldOutOnly = Object.keys(req.body || {}).length === 1 && Object.keys(req.body || {}).every((key) => key === "isSoldOut"); if (!id || !req.body || (req.body.isSoldOut !== undefined && typeof req.body.isSoldOut !== "boolean")) return res.status(400).json({ error: "Invalid menu item details" }); if (!owner && !soldOutOnly) return res.status(403).json({ error: "Only Owners can change menu details" }); const categoryId = req.body?.categoryId === undefined ? null : validId(req.body.categoryId), price = req.body?.priceCents === undefined ? null : asInteger(req.body.priceCents), order = req.body?.displayOrder === undefined ? null : asInteger(req.body.displayOrder); if (owner && ((req.body.categoryId !== undefined && !categoryId) || (req.body.name !== undefined && !text(req.body.name, 140)) || (price !== null && (price < 0 || price > 1000000)) || (order !== null && order < 0) || (req.body.isActive !== undefined && typeof req.body.isActive !== "boolean"))) return res.status(400).json({ error: "Invalid menu item details" }); const result = await database.query(`UPDATE food_items SET is_sold_out = COALESCE($1,is_sold_out), category_id = CASE WHEN $2 THEN COALESCE($3,category_id) ELSE category_id END, name = CASE WHEN $2 THEN COALESCE($4,name) ELSE name END, description = CASE WHEN $2 THEN $5 ELSE description END, price_cents = CASE WHEN $2 THEN COALESCE($6,price_cents) ELSE price_cents END, image_url = CASE WHEN $2 THEN $7 ELSE image_url END, display_order = CASE WHEN $2 THEN COALESCE($8,display_order) ELSE display_order END, is_active = CASE WHEN $2 THEN COALESCE($9,is_active) ELSE is_active END, updated_at=CURRENT_TIMESTAMP WHERE id=$10 RETURNING *`, [typeof req.body?.isSoldOut === "boolean" ? req.body.isSoldOut : null, owner, categoryId, req.body?.name === undefined ? null : text(req.body.name, 140), req.body?.description === undefined ? null : text(req.body.description, 1000) || null, price, req.body?.imageUrl === undefined ? null : text(req.body.imageUrl, 1024) || null, order, typeof req.body?.isActive === "boolean" ? req.body.isActive : null, id]); if (!result.rowCount) return res.status(404).json({ error: "Menu item not found" }); await writeAudit(database, req.admin.id, owner ? "FOOD_ITEM_UPDATE" : "FOOD_ITEM_SOLD_OUT", "FOOD_ITEM", id); res.json({ item: mapItem(result.rows[0]) }); });
  router.post("/orders/:id/status", requireAdminSession, requireRole("OWNER", "STAFF"), requireCsrf, async (req, res) => { const next = String(req.body?.status || "").toUpperCase(); const client = await database.connect(); try { await client.query("BEGIN"); const result = await client.query("SELECT status FROM food_orders WHERE id=$1 FOR UPDATE", [req.params.id]); if (!result.rowCount) throw httpError(404, "Order not found"); const previous = result.rows[0].status; if (!ORDER_TRANSITIONS[previous]?.includes(next)) throw httpError(409, "That order transition is not allowed", "ORDER_TRANSITION_INVALID"); await client.query("UPDATE food_orders SET status=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [next, req.params.id]); await client.query("INSERT INTO food_order_history (food_order_id,admin_user_id,event_type,previous_value,next_value) VALUES ($1,$2,'STATUS_CHANGED',$3,$4)", [req.params.id, req.admin.id, previous, next]); await writeAudit(client, req.admin.id, "FOOD_ORDER_STATUS", "FOOD_ORDER", req.params.id, { previous, next }); await client.query("COMMIT"); res.json({ order: await loadOrder(database, req.params.id) }); } catch (error) { await client.query("ROLLBACK").catch(() => {}); res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Failed to update order", ...(error.code ? { code: error.code } : {}) }); } finally { client.release(); } });
  router.post("/orders/:id/payment", requireAdminSession, requireRole("OWNER", "STAFF"), requireCsrf, async (req, res) => { if (String(req.body?.paymentStatus || "").toUpperCase() !== "PAID") return res.status(400).json({ error: "Only PAID can be recorded" }); const client = await database.connect(); try { await client.query("BEGIN"); const result = await client.query("SELECT payment_status FROM food_orders WHERE id=$1 FOR UPDATE", [req.params.id]); if (!result.rowCount) throw httpError(404, "Order not found"); if (result.rows[0].payment_status !== "PAID") { await client.query("UPDATE food_orders SET payment_status='PAID',updated_at=CURRENT_TIMESTAMP WHERE id=$1", [req.params.id]); await client.query("INSERT INTO food_order_history (food_order_id,admin_user_id,event_type,previous_value,next_value) VALUES ($1,$2,'PAYMENT_CHANGED',$3,'PAID')", [req.params.id, req.admin.id, result.rows[0].payment_status]); await writeAudit(client, req.admin.id, "FOOD_ORDER_PAYMENT", "FOOD_ORDER", req.params.id); } await client.query("COMMIT"); res.json({ order: await loadOrder(database, req.params.id) }); } catch (error) { await client.query("ROLLBACK").catch(() => {}); res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Failed to record payment" }); } finally { client.release(); } });
  return router;
}
module.exports = { ORDER_TRANSITIONS, createFoodRouter, createAdminFoodRouter };
