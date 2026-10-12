const bcrypt = require("bcrypt");
const express = require("express");
const { AppError, asyncRoute } = require("../lib/http");
const validation = require("../lib/validation");
const { requireAdmin, requireCsrf, requireOwner, audit } = require("../lib/auth");
const { requireKitchenOrAdmin } = require('../lib/kitchenDevice');
const { canTransition, calculateTotals } = require("../lib/orderPolicy");
const { uploadMiddleware, finalizeImage, removeUploadedImage } = require("../lib/imageUpload");
const { INVENTORY_MODES, effectiveAvailability, applyInventoryDeltas, restoreOrderInventory } = require("../lib/inventory");

function asMenuItem(row, modifierGroups = []) {
  const visibilityReason = !row.category_is_active ? "CATEGORY_INACTIVE"
    : !row.is_active ? "ITEM_INACTIVE"
      : !row.is_available ? "ITEM_UNAVAILABLE"
        : row.inventory_mode === INVENTORY_MODES.QUANTITY_TRACKED && Number(row.available_quantity) === 0 ? "QUANTITY_DEPLETED" : "VISIBLE";
  return {
    id: String(row.id), categoryId: String(row.category_id), categoryName: row.category_name,
    name: row.name, description: row.description, priceCents: row.price_cents,
    imagePath: row.primary_image_path, imageAlt: row.image_alt_text,
    dietaryInformation: row.dietary_information || "",
    dietaryInformationVerified: row.dietary_information_verified === true,
    allergenInformation: row.allergen_information || "",
    allergenInformationVerified: row.allergen_information_verified === true,
    modifierGroups,
    displayOrder: row.display_order, isActive: row.is_active,
    isAvailable: row.is_available, effectiveAvailable: effectiveAvailability(row), isFeatured: row.is_featured,
    inventoryMode: row.inventory_mode || INVENTORY_MODES.MANUAL,
    availableQuantity: row.available_quantity == null ? null : Number(row.available_quantity),
    canPermanentlyDelete: row.has_order_history === false,
    permanentDeleteReason: row.has_order_history ? "This item is used in order history and must be retained." : "",
    categoryIsActive: row.category_is_active,
    publicVisibility: { isVisible: visibilityReason === "VISIBLE", reason: visibilityReason },
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function menuInput(body) {
  const dietaryInformation = validation.text(body.dietaryInformation, "dietaryInformation", { required: false, max: 1000 });
  const allergenInformation = validation.text(body.allergenInformation, "allergenInformation", { required: false, max: 1000 });
  const dietaryInformationVerified = validation.boolean(body.dietaryInformationVerified ?? false, "dietaryInformationVerified");
  const allergenInformationVerified = validation.boolean(body.allergenInformationVerified ?? false, "allergenInformationVerified");
  if (dietaryInformationVerified && !dietaryInformation) throw new AppError(422, "VERIFIED_DIETARY_INFORMATION_REQUIRED", "Enter dietary information before marking it verified.", { field: "dietaryInformation" });
  if (allergenInformationVerified && !allergenInformation) throw new AppError(422, "VERIFIED_ALLERGEN_INFORMATION_REQUIRED", "Enter allergen information before marking it verified.", { field: "allergenInformation" });
  const inventoryMode = validation.text(body.inventoryMode ?? INVENTORY_MODES.MANUAL, "inventoryMode", { max: 30 }).toUpperCase();
  if (!Object.values(INVENTORY_MODES).includes(inventoryMode)) throw new AppError(422, "VALIDATION_ERROR", "Inventory mode must be Manual or Track Quantity.", { field: "inventoryMode" });
  const availableQuantity = inventoryMode === INVENTORY_MODES.QUANTITY_TRACKED
    ? validation.integer(body.availableQuantity, "availableQuantity", { minimum: 0, maximum: 1000000 })
    : body.availableQuantity == null || body.availableQuantity === "" ? null
      : validation.integer(body.availableQuantity, "availableQuantity", { minimum: 0, maximum: 1000000 });
  return {
    categoryId: validation.integer(body.categoryId, "categoryId", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    name: validation.text(body.name, "name", { max: 160 }),
    description: validation.text(body.description, "description", { required: false, max: 2000 }),
    priceCents: validation.integer(body.priceCents, "priceCents", { minimum: 0, maximum: 1000000 }),
    imageAlt: validation.text(body.imageAlt, "imageAlt", { required: false, max: 300 }),
    displayOrder: validation.integer(body.displayOrder ?? 0, "displayOrder", { minimum: 0, maximum: 100000 }),
    isActive: validation.boolean(body.isActive ?? true, "isActive"),
    isAvailable: validation.boolean(body.isAvailable ?? true, "isAvailable"),
    isFeatured: validation.boolean(body.isFeatured ?? false, "isFeatured"),
    inventoryMode, availableQuantity,
    dietaryInformation, dietaryInformationVerified, allergenInformation, allergenInformationVerified
  };
}

function modifierGroupsInput(value) {
  let groups = value ?? [];
  if (typeof groups === "string") {
    try { groups = JSON.parse(groups || "[]"); }
    catch { throw new AppError(422, "INVALID_MODIFIER_CONFIGURATION", "Modifier configuration could not be read. Review the groups and options.", { field: "modifierGroups" }); }
  }
  if (!Array.isArray(groups) || groups.length > 20) throw new AppError(422, "INVALID_MODIFIER_CONFIGURATION", "Provide no more than 20 modifier groups.", { field: "modifierGroups" });
  return groups.map((group, groupIndex) => {
    const name = validation.text(group?.name, `modifierGroups[${groupIndex}].name`, { max: 120 });
    const minimumSelections = validation.integer(group?.minimumSelections ?? 0, `modifierGroups[${groupIndex}].minimumSelections`, { minimum: 0, maximum: 50 });
    const maximumSelections = validation.integer(group?.maximumSelections ?? 1, `modifierGroups[${groupIndex}].maximumSelections`, { minimum: 1, maximum: 50 });
    if (minimumSelections > maximumSelections) throw new AppError(422, "INVALID_MODIFIER_CONFIGURATION", `${name}: minimum selections cannot exceed maximum selections.`, { field: "modifierGroups" });
    if (!Array.isArray(group?.options) || !group.options.length || group.options.length > 50) throw new AppError(422, "INVALID_MODIFIER_CONFIGURATION", `${name}: add between 1 and 50 options.`, { field: "modifierGroups" });
    const options = group.options.map((option, optionIndex) => ({
      name: validation.text(option?.name, `modifierGroups[${groupIndex}].options[${optionIndex}].name`, { max: 120 }),
      priceDeltaCents: validation.integer(option?.priceDeltaCents ?? 0, `modifierGroups[${groupIndex}].options[${optionIndex}].priceDeltaCents`, { minimum: 0, maximum: 1000000 }),
      displayOrder: optionIndex
    }));
    const normalizedNames = options.map((option) => option.name.trim().toLowerCase());
    if (new Set(normalizedNames).size !== normalizedNames.length) throw new AppError(422, "INVALID_MODIFIER_CONFIGURATION", `${name}: option names must be unique.`, { field: "modifierGroups" });
    if (maximumSelections > options.length || minimumSelections > options.length) throw new AppError(422, "INVALID_MODIFIER_CONFIGURATION", `${name}: selection limits cannot exceed the number of options.`, { field: "modifierGroups" });
    return { name, minimumSelections, maximumSelections, displayOrder: groupIndex, options };
  });
}

async function replaceModifierGroups(database, menuItemId, groups) {
  await database.query("UPDATE menu_modifier_groups SET is_active=FALSE WHERE menu_item_id=$1 AND is_active=TRUE", [menuItemId]);
  for (const group of groups) {
    const created = await database.query(`INSERT INTO menu_modifier_groups
      (menu_item_id,name,minimum_selections,maximum_selections,display_order)
      VALUES ($1,$2,$3,$4,$5) RETURNING id`, [menuItemId, group.name, group.minimumSelections, group.maximumSelections, group.displayOrder]);
    for (const option of group.options) {
      await database.query(`INSERT INTO menu_modifier_options
        (modifier_group_id,name,price_delta_cents,display_order) VALUES ($1,$2,$3,$4)`,
      [created.rows[0].id, option.name, option.priceDeltaCents, option.displayOrder]);
    }
  }
}

async function modifierGroupsForItems(database, itemIds) {
  const byItem = new Map(itemIds.map((id) => [String(id), []]));
  if (!itemIds.length) return byItem;
  const result = await database.query(`SELECT g.id AS group_id,g.menu_item_id,g.name AS group_name,
    g.minimum_selections,g.maximum_selections,g.display_order AS group_order,
    o.id AS option_id,o.name AS option_name,o.price_delta_cents,o.display_order AS option_order
    FROM menu_modifier_groups g
    LEFT JOIN menu_modifier_options o ON o.modifier_group_id=g.id AND o.is_active=TRUE
    WHERE g.menu_item_id=ANY($1::bigint[]) AND g.is_active=TRUE
    ORDER BY g.menu_item_id,g.display_order,g.id,o.display_order,o.id`, [itemIds]);
  const groupMap = new Map();
  for (const row of result.rows) {
    const key = String(row.group_id);
    let group = groupMap.get(key);
    if (!group) {
      group = { id: key, name: row.group_name, minimumSelections: row.minimum_selections,
        maximumSelections: row.maximum_selections, options: [] };
      groupMap.set(key, group);
      byItem.get(String(row.menu_item_id))?.push(group);
    }
    if (row.option_id) group.options.push({ id: String(row.option_id), name: row.option_name, priceDeltaCents: row.price_delta_cents });
  }
  return byItem;
}

function categoryInput(body) {
  return {
    name: validation.text(body.name, "name", { max: 120 }),
    slug: validation.slug(body.slug),
    description: validation.text(body.description, "description", { required: false, max: 1000 }),
    displayOrder: validation.integer(body.displayOrder ?? 0, "displayOrder", { minimum: 0, maximum: 100000 }),
    isActive: validation.boolean(body.isActive ?? true, "isActive")
  };
}

function specialInput(body) {
  const priceCents = body.priceCents === "" || body.priceCents == null ? null : validation.integer(body.priceCents, "priceCents", { minimum: 0, maximum: 1000000 });
  const activeFrom = body.activeFrom || null;
  const activeUntil = body.activeUntil || null;
  if (activeFrom && !/^\d{4}-\d{2}-\d{2}$/.test(activeFrom)) throw new AppError(422, "VALIDATION_ERROR", "activeFrom must be a date.", { field: "activeFrom" });
  if (activeUntil && !/^\d{4}-\d{2}-\d{2}$/.test(activeUntil)) throw new AppError(422, "VALIDATION_ERROR", "activeUntil must be a date.", { field: "activeUntil" });
  return {
    title: validation.text(body.title, "title", { max: 160 }),
    description: validation.text(body.description, "description", { required: false, max: 1500 }),
    priceCents,
    dayLabel: validation.text(body.dayLabel, "dayLabel", { required: false, max: 80 }),
    activeFrom, activeUntil,
    imageAlt: validation.text(body.imageAlt, "imageAlt", { required: false, max: 300 }),
    displayOrder: validation.integer(body.displayOrder ?? 0, "displayOrder", { minimum: 0, maximum: 100000 }),
    isActive: validation.boolean(body.isActive ?? true, "isActive"),
    isSoldOut: validation.boolean(body.isSoldOut ?? false, "isSoldOut")
  };
}

function cateringResponse(row) {
  return {
    requestNumber: row.public_request_number,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    company: row.company,
    eventDate: row.event_date,
    pickupTime: row.pickup_time,
    guestCount: row.guest_count,
    orderType: row.order_type,
    interestedIn: row.interested_in || [],
    specialNotes: row.special_notes || "",
    preferredContactMethod: row.preferred_contact_method,
    adminNotes: row.admin_notes || "",
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function categoryExists(database, id) {
  const result = await database.query("SELECT id, name, is_active FROM menu_categories WHERE id = $1", [id]);
  if (!result.rowCount) throw new AppError(422, "CATEGORY_NOT_FOUND", "Choose an existing category.", { field: "categoryId" });
  return result.rows[0];
}

async function ensureUniqueCategorySlug(database, slug, excludingId = null) {
  const result = await database.query(
    "SELECT id FROM menu_categories WHERE slug = $1 AND ($2::bigint IS NULL OR id <> $2)",
    [slug, excludingId]
  );
  if (result.rowCount) throw new AppError(409, "CATEGORY_SLUG_EXISTS", "A category already uses this slug. Choose a different slug.", { field: "slug" });
}

async function menuItemWithCategory(database, id) {
  const result = await database.query(`SELECT i.*, c.name AS category_name, c.is_active AS category_is_active
    FROM menu_items i JOIN menu_categories c ON c.id = i.category_id WHERE i.id = $1`, [id]);
  return result.rows[0];
}

async function menuItemResponse(database, id) {
  const row = await menuItemWithCategory(database, id);
  const modifiers = await modifierGroupsForItems(database, [id]);
  return asMenuItem(row, modifiers.get(String(id)) || []);
}

function isActiveOrder(order) {
  return !["COMPLETED", "CANCELLED"].includes(order.status);
}

async function activeOrderForUpdate(client, orderNumber) {
  const result = await client.query("SELECT * FROM orders WHERE public_order_number=$1 FOR UPDATE", [orderNumber]);
  if (!result.rowCount) throw new AppError(404, "ORDER_NOT_FOUND", "Order was not found.");
  if (!isActiveOrder(result.rows[0])) throw new AppError(409, "ORDER_READ_ONLY", "Completed and cancelled orders are read-only.");
  return result.rows[0];
}

async function effectiveOrderItems(client, orderId) {
  const base = await client.query(`SELECT id,menu_item_id,item_name_snapshot,description_snapshot,unit_price_cents,modifier_total_cents,quantity,line_total_cents,customer_item_notes,inventory_reserved_quantity
    FROM order_items WHERE order_id=$1 ORDER BY id`, [orderId]);
  const adjustments = await client.query(`SELECT DISTINCT ON (line_key) * FROM order_item_adjustments
    WHERE order_id=$1 ORDER BY line_key,id DESC`, [orderId]);
  const lines = new Map(base.rows.map((item) => [`base-${item.id}`, {
    ...item, lineKey: `base-${item.id}`, modifierSourceId: item.id, sourceMenuPriceCents: item.unit_price_cents
  }]));
  for (const adjustment of adjustments.rows) {
    if (adjustment.operation === "REMOVE") { lines.delete(adjustment.line_key); continue; }
    const prior = lines.get(adjustment.line_key) || {};
    lines.set(adjustment.line_key, {
      ...prior, ...adjustment, lineKey: adjustment.line_key,
      id: adjustment.base_order_item_id || adjustment.id,
      modifierSourceId: prior.modifierSourceId || null,
      sourceMenuPriceCents: prior.sourceMenuPriceCents ?? adjustment.unit_price_cents,
      line_total_cents: (adjustment.unit_price_cents + adjustment.modifier_total_cents) * adjustment.quantity
    });
  }
  return [...lines.values()].sort((a, b) => String(a.lineKey).localeCompare(String(b.lineKey)));
}

async function refreshOrderTotals(client, orderId) {
  const lines = await effectiveOrderItems(client, orderId);
  const settings = await client.query("SELECT order_tax_basis_points FROM site_settings LIMIT 1");
  if (!lines.length) throw new AppError(409, "ORDER_REQUIRES_ITEM", "An order must contain at least one item.");
  const totals = calculateTotals(lines.map((line) => ({ unitPriceCents: line.unit_price_cents, modifierTotalCents: line.modifier_total_cents, quantity: line.quantity })), settings.rows[0]?.order_tax_basis_points || 0);
  await client.query("UPDATE orders SET subtotal_cents=$2,tax_cents=$3,total_cents=$4 WHERE id=$1", [orderId, totals.subtotalCents, totals.taxCents, totals.totalCents]);
  return totals;
}

async function availableMenuItem(client, menuItemId) {
  const result = await client.query(`SELECT i.id,i.name,i.description,i.price_cents,i.inventory_mode,i.available_quantity,i.is_available
    FROM menu_items i JOIN menu_categories c ON c.id=i.category_id
    WHERE i.id=$1 AND i.is_active AND c.is_active FOR UPDATE OF i`, [menuItemId]);
  if (!result.rowCount || !effectiveAvailability(result.rows[0])) throw new AppError(422, "MENU_ITEM_UNAVAILABLE", "Choose an active, available menu item.", { field: "menuItemId" });
  return result.rows[0];
}

function buildAdminRouter(database, config, pushNotifications = { configured: false, sendStatusChanged: async () => ({ configured: false }) }) {
  const router = express.Router();
  router.use(requireKitchenOrAdmin(database));
  router.use((req, res, next) => req.kitchenDeviceHash || new Set(["GET", "HEAD", "OPTIONS"]).has(req.method) ? next() : requireCsrf(req, res, next));

  router.get('/device-session', (req, res) => res.json({ user: req.admin }));

  router.post("/push/register", asyncRoute(async (req, res) => {
    if (!pushNotifications.configured) throw new AppError(503, "PUSH_NOT_CONFIGURED", "Order alerts are not configured yet.");
    const token = validation.text(req.body.token, "token", { max: 4096 });
    if (token.length < 20) throw new AppError(422, "VALIDATION_ERROR", "token is invalid.", { field: "token" });
    const platform = validation.text(req.body.platform || "ANDROID", "platform", { max: 20 }).toUpperCase();
    if (platform !== "ANDROID") throw new AppError(422, "VALIDATION_ERROR", "platform must be ANDROID.", { field: "platform" });
    const deviceName = validation.text(req.body.deviceName, "deviceName", { required: false, max: 200 });
    const locale = validation.text(req.body.locale || "en", "locale", { max: 10 }).toLowerCase();
    if (!new Set(["en", "ru"]).has(locale)) throw new AppError(422, "VALIDATION_ERROR", "locale must be en or ru.", { field: "locale" });
    await database.query(`INSERT INTO admin_push_subscriptions
      (admin_user_id,fcm_token,platform,device_name,locale,kitchen_device_hash,enabled,last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,TRUE,NOW())
      ON CONFLICT (fcm_token) DO UPDATE SET
        admin_user_id=EXCLUDED.admin_user_id,platform=EXCLUDED.platform,
        device_name=EXCLUDED.device_name,locale=EXCLUDED.locale,kitchen_device_hash=EXCLUDED.kitchen_device_hash,enabled=TRUE,
        updated_at=NOW(),last_seen_at=NOW()`,
    [req.admin.id, token, platform, deviceName, locale, req.kitchenDeviceHash || null]);
    await audit(database, req, "PUSH_DEVICE_REGISTERED", "push_device", null, { platform, deviceName, locale });
    res.status(201).json({ registered: true });
  }));

  router.delete("/push/register", asyncRoute(async (req, res) => {
    const token = validation.text(req.body.token, "token", { max: 4096 });
    await database.query(`UPDATE admin_push_subscriptions SET enabled=FALSE,updated_at=NOW()
      WHERE fcm_token=$1 AND ($2::text IS NULL OR kitchen_device_hash=$2)`, [token, req.kitchenDeviceHash || null]);
    await audit(database, req, "PUSH_DEVICE_DISABLED", "push_device", null, { platform: "ANDROID" });
    res.status(204).end();
  }));

  router.get("/dashboard", asyncRoute(async (req, res) => {
    const [metrics, recentOrders, specials, settings, activity] = await Promise.all([
      database.query(`SELECT
        (SELECT COUNT(*)::integer FROM menu_items WHERE is_active) AS menu_items,
        (SELECT COUNT(*)::integer FROM menu_categories WHERE is_active) AS active_categories,
        (SELECT COUNT(*)::integer FROM daily_specials WHERE is_active AND NOT is_sold_out
          AND (active_from IS NULL OR active_from <= CURRENT_DATE)
          AND (active_until IS NULL OR active_until >= CURRENT_DATE)) AS today_specials,
        (SELECT COUNT(*)::integer FROM orders WHERE status = 'PENDING') AS pending_orders,
        (SELECT COUNT(*)::integer FROM orders WHERE status IN ('CONFIRMED','PREPARING')) AS accepted_orders,
        (SELECT COUNT(*)::integer FROM orders WHERE status = 'READY') AS ready_orders,
        (SELECT COUNT(*)::integer FROM orders WHERE created_at::date = CURRENT_DATE) AS today_orders,
        (SELECT COUNT(*)::integer FROM orders WHERE status = 'COMPLETED' AND updated_at::date = CURRENT_DATE) AS completed_today,
        (SELECT COUNT(*)::integer FROM catering_requests WHERE status = 'NEW') AS new_catering_requests,
        (SELECT COUNT(*)::integer FROM menu_items WHERE is_active AND NOT is_available) AS sold_out_items,
        (SELECT COUNT(*)::integer FROM gallery_items WHERE is_active) AS gallery_photos`),
      database.query(`SELECT o.public_order_number, o.daily_ticket_number, o.customer_name, o.order_type, o.requested_at, o.estimated_ready_at,
        o.total_cents, o.status, o.created_at, COALESCE(SUM(oi.quantity),0)::integer AS item_count
        FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id
        WHERE o.status IN ('PENDING','CONFIRMED','PREPARING','READY')
        GROUP BY o.id ORDER BY COALESCE(o.estimated_ready_at,o.requested_at,o.created_at), o.created_at LIMIT 20`),
      database.query(`SELECT title, day_label, price_cents, is_active FROM daily_specials
        WHERE is_active AND NOT is_sold_out
          AND (active_from IS NULL OR active_from <= CURRENT_DATE)
          AND (active_until IS NULL OR active_until >= CURRENT_DATE)
        ORDER BY display_order, id LIMIT 7`),
      database.query("SELECT address, phone, email, accepting_orders FROM site_settings WHERE id = 1"),
      database.query("SELECT event_type, entity_type, entity_identifier, created_at FROM audit_events ORDER BY created_at DESC LIMIT 8")
    ]);
    res.json({ metrics: metrics.rows[0], recentOrders: recentOrders.rows, specials: specials.rows,
      settings: settings.rows[0], recentActivity: activity.rows });
  }));

  router.get("/catering-requests", asyncRoute(async (req, res) => {
    const params = [];
    const where = [];
    if (req.query.search) {
      params.push(`%${String(req.query.search).slice(0, 120)}%`);
      where.push(`(full_name ILIKE $${params.length} OR company ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length} OR public_request_number ILIKE $${params.length})`);
    }
    if (req.query.status) {
      const status = validation.text(req.query.status, "status", { max: 20 }).toUpperCase();
      if (!new Set(["NEW", "CONTACTED", "QUOTING", "CONFIRMED", "DECLINED", "COMPLETED"]).has(status)) throw new AppError(422, "VALIDATION_ERROR", "Choose a valid catering status.", { field: "status" });
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    params.push(validation.integer(req.query.limit || 200, "limit", { minimum: 1, maximum: 200 }));
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const result = await database.query(`SELECT public_request_number,full_name,phone,email,company,event_date,pickup_time,
      guest_count,order_type,interested_in,preferred_contact_method,status,created_at,updated_at
      FROM catering_requests ${clause} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    res.json({ requests: result.rows.map(cateringResponse) });
  }));

  router.get("/catering-requests/:requestNumber", asyncRoute(async (req, res) => {
    const result = await database.query("SELECT * FROM catering_requests WHERE public_request_number=$1", [req.params.requestNumber]);
    if (!result.rowCount) throw new AppError(404, "CATERING_REQUEST_NOT_FOUND", "Catering request was not found.");
    res.json({ request: cateringResponse(result.rows[0]) });
  }));

  router.patch("/catering-requests/:requestNumber/status", asyncRoute(async (req, res) => {
    const status = validation.text(req.body.status, "status", { max: 20 }).toUpperCase();
    if (!new Set(["NEW", "CONTACTED", "QUOTING", "CONFIRMED", "DECLINED", "COMPLETED"]).has(status)) throw new AppError(422, "VALIDATION_ERROR", "Choose a valid catering status.", { field: "status" });
    const result = await database.query("UPDATE catering_requests SET status=$2 WHERE public_request_number=$1 RETURNING *", [req.params.requestNumber, status]);
    if (!result.rowCount) throw new AppError(404, "CATERING_REQUEST_NOT_FOUND", "Catering request was not found.");
    await audit(database, req, "CATERING_STATUS_UPDATED", "catering_request", req.params.requestNumber, { status });
    res.json({ request: cateringResponse(result.rows[0]) });
  }));

  router.patch("/catering-requests/:requestNumber/notes", asyncRoute(async (req, res) => {
    const adminNotes = validation.text(req.body.adminNotes, "adminNotes", { required: false, max: 5000 });
    const result = await database.query("UPDATE catering_requests SET admin_notes=$2 WHERE public_request_number=$1 RETURNING *", [req.params.requestNumber, adminNotes]);
    if (!result.rowCount) throw new AppError(404, "CATERING_REQUEST_NOT_FOUND", "Catering request was not found.");
    await audit(database, req, "CATERING_NOTES_UPDATED", "catering_request", req.params.requestNumber);
    res.json({ request: cateringResponse(result.rows[0]) });
  }));

  router.get("/menu-items", asyncRoute(async (req, res) => {
    const params = [];
    const where = [];
    if (req.query.search) { params.push(`%${String(req.query.search).slice(0, 120)}%`); where.push(`(i.name ILIKE $${params.length} OR i.description ILIKE $${params.length})`); }
    if (req.query.categoryId) { params.push(validation.integer(req.query.categoryId, "categoryId", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER })); where.push(`i.category_id = $${params.length}`); }
    if (req.query.active === "true" || req.query.active === "false") { params.push(req.query.active === "true"); where.push(`i.is_active = $${params.length}`); }
    if (req.query.available === "true" || req.query.available === "false") { params.push(req.query.available === "true"); where.push(`i.is_available = $${params.length}`); }
    const page = validation.integer(req.query.page || 1, "page", { minimum: 1, maximum: 100000 });
    const pageSize = validation.integer(req.query.pageSize || 50, "pageSize", { minimum: 1, maximum: 100 });
    params.push(pageSize, (page - 1) * pageSize);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const result = await database.query(`SELECT i.*, c.name AS category_name, c.is_active AS category_is_active,
      (EXISTS (SELECT 1 FROM order_items oi WHERE oi.menu_item_id=i.id)
       OR EXISTS (SELECT 1 FROM order_item_adjustments oa WHERE oa.menu_item_id=i.id)) AS has_order_history,
      COUNT(*) OVER()::integer AS total_count
      FROM menu_items i JOIN menu_categories c ON c.id = i.category_id ${clause}
      ORDER BY i.display_order, i.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const modifiers = await modifierGroupsForItems(database, result.rows.map((row) => row.id));
    res.json({ items: result.rows.map((row) => asMenuItem(row, modifiers.get(String(row.id)) || [])), page, pageSize, total: result.rows[0]?.total_count || 0 });
  }));

  router.post("/menu-items", uploadMiddleware(config), asyncRoute(async (req, res) => {
    let imagePath;
    try {
      const input = menuInput(req.body);
      const modifierGroups = modifierGroupsInput(req.body.modifierGroups);
      await categoryExists(database, input.categoryId);
      imagePath = await finalizeImage(req.file, config);
      const client = await database.connect();
      let result;
      try {
        await client.query("BEGIN");
        result = await client.query(`INSERT INTO menu_items (category_id, name, description, price_cents,
          primary_image_path, image_alt_text, display_order, is_active, is_available, is_featured,
          dietary_information,dietary_information_verified,allergen_information,allergen_information_verified,
          inventory_mode,available_quantity)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`, [input.categoryId, input.name, input.description,
          input.priceCents, imagePath, input.imageAlt, input.displayOrder, input.isActive, input.isAvailable, input.isFeatured,
          input.dietaryInformation,input.dietaryInformationVerified,input.allergenInformation,input.allergenInformationVerified,
          input.inventoryMode,input.availableQuantity]);
        await replaceModifierGroups(client, result.rows[0].id, modifierGroups);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
      await audit(database, req, "MENU_ITEM_CREATED", "menu_item", String(result.rows[0].id), { name: input.name });
      res.status(201).json({ item: await menuItemResponse(database, result.rows[0].id) });
    } catch (error) {
      if (imagePath) await removeUploadedImage(imagePath, config).catch(() => {});
      throw error;
    }
  }));

  router.patch("/menu-items/:id", uploadMiddleware(config), asyncRoute(async (req, res) => {
    const id = validation.integer(req.params.id, "id", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    const existing = await database.query("SELECT * FROM menu_items WHERE id = $1", [id]);
    if (!existing.rowCount) throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Menu item was not found.");
    let imagePath;
    try {
      const merged = {
        categoryId: req.body.categoryId ?? existing.rows[0].category_id,
        name: req.body.name ?? existing.rows[0].name,
        description: req.body.description ?? existing.rows[0].description,
        priceCents: req.body.priceCents ?? existing.rows[0].price_cents,
        imageAlt: req.body.imageAlt ?? existing.rows[0].image_alt_text,
        displayOrder: req.body.displayOrder ?? existing.rows[0].display_order,
        isActive: req.body.isActive ?? existing.rows[0].is_active,
        isAvailable: req.body.isAvailable ?? existing.rows[0].is_available,
        isFeatured: req.body.isFeatured ?? existing.rows[0].is_featured,
        dietaryInformation: req.body.dietaryInformation ?? existing.rows[0].dietary_information,
        dietaryInformationVerified: req.body.dietaryInformationVerified ?? existing.rows[0].dietary_information_verified,
        allergenInformation: req.body.allergenInformation ?? existing.rows[0].allergen_information,
        allergenInformationVerified: req.body.allergenInformationVerified ?? existing.rows[0].allergen_information_verified,
        inventoryMode: req.body.inventoryMode ?? existing.rows[0].inventory_mode,
        availableQuantity: req.body.availableQuantity ?? existing.rows[0].available_quantity
      };
      const input = menuInput(merged);
      const modifierGroups = req.body.modifierGroups == null ? null : modifierGroupsInput(req.body.modifierGroups);
      await categoryExists(database, input.categoryId);
      imagePath = await finalizeImage(req.file, config);
      const finalImagePath = req.body.removeImage === "true" || req.body.removeImage === true ? null : imagePath || existing.rows[0].primary_image_path;
      const client = await database.connect();
      let result;
      try {
        await client.query("BEGIN");
        result = await client.query(`UPDATE menu_items SET category_id=$2,name=$3,description=$4,price_cents=$5,
          primary_image_path=$6,image_alt_text=$7,display_order=$8,is_active=$9,is_available=$10,is_featured=$11,
          dietary_information=$12,dietary_information_verified=$13,allergen_information=$14,allergen_information_verified=$15,
          inventory_mode=$16,available_quantity=$17
          WHERE id=$1 RETURNING *`, [id, input.categoryId, input.name, input.description, input.priceCents,
          finalImagePath, input.imageAlt, input.displayOrder, input.isActive, input.isAvailable, input.isFeatured,
          input.dietaryInformation,input.dietaryInformationVerified,input.allergenInformation,input.allergenInformationVerified,
          input.inventoryMode,input.availableQuantity]);
        if (modifierGroups) await replaceModifierGroups(client, id, modifierGroups);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
      if (existing.rows[0].primary_image_path && finalImagePath !== existing.rows[0].primary_image_path) {
        await removeUploadedImage(existing.rows[0].primary_image_path, config);
      }
      await audit(database, req, "MENU_ITEM_UPDATED", "menu_item", String(id), { name: input.name });
      res.json({ item: await menuItemResponse(database, result.rows[0].id) });
    } catch (error) {
      if (imagePath) await removeUploadedImage(imagePath, config).catch(() => {});
      throw error;
    }
  }));

  router.delete("/menu-items/:id", asyncRoute(async (req, res) => {
    const id = validation.integer(req.params.id, "id", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    const result = await database.query("UPDATE menu_items SET is_active = FALSE, is_available = FALSE WHERE id = $1 RETURNING id", [id]);
    if (!result.rowCount) throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Menu item was not found.");
    await audit(database, req, "MENU_ITEM_ARCHIVED", "menu_item", String(id));
    res.status(204).end();
  }));

  router.delete("/menu-items/:id/permanent", asyncRoute(async (req, res) => {
    const id = validation.integer(req.params.id, "id", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    const client = await database.connect();
    let item;
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT id,name,primary_image_path,is_active,is_available FROM menu_items WHERE id=$1 FOR UPDATE", [id]);
      if (!found.rowCount) throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Menu item was not found.");
      item = found.rows[0];
      if (item.is_active || item.is_available) throw new AppError(409, "MENU_ITEM_NOT_ARCHIVED", "Archive this item before deleting it permanently.");
      const history = await client.query(`SELECT
        EXISTS (SELECT 1 FROM order_items WHERE menu_item_id=$1)
        OR EXISTS (SELECT 1 FROM order_item_adjustments WHERE menu_item_id=$1) AS retained`, [id]);
      if (history.rows[0].retained) throw new AppError(409, "MENU_ITEM_HISTORY_RETAINED", "This item is used in order history and must be retained.");
      await client.query("DELETE FROM menu_items WHERE id=$1", [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
    if (item.primary_image_path) await removeUploadedImage(item.primary_image_path, config).catch(() => {});
    await audit(database, req, "MENU_ITEM_PERMANENTLY_DELETED", "menu_item", String(id), { name: item.name });
    res.status(204).end();
  }));

  router.get("/categories", asyncRoute(async (req, res) => {
    const result = await database.query(`SELECT c.*, COUNT(i.id)::integer AS item_count,
      COUNT(i.id) FILTER (WHERE i.is_active)::integer AS active_item_count
      FROM menu_categories c LEFT JOIN menu_items i ON i.category_id = c.id
      GROUP BY c.id ORDER BY c.display_order, c.id`);
    res.json({ categories: result.rows.map((row) => ({ id: String(row.id), name: row.name, slug: row.slug,
      description: row.description, displayOrder: row.display_order, isActive: row.is_active,
      itemCount: row.item_count, activeItemCount: row.active_item_count })) });
  }));

  router.post("/categories", asyncRoute(async (req, res) => {
    const input = categoryInput(req.body);
    await ensureUniqueCategorySlug(database, input.slug);
    const result = await database.query(`INSERT INTO menu_categories (name,slug,description,display_order,is_active)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`, [input.name, input.slug, input.description, input.displayOrder, input.isActive]);
    await audit(database, req, "CATEGORY_CREATED", "menu_category", String(result.rows[0].id), { name: input.name });
    res.status(201).json({ category: result.rows[0] });
  }));

  router.patch("/categories/:id", asyncRoute(async (req, res) => {
    const id = validation.integer(req.params.id, "id", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    const current = await database.query("SELECT * FROM menu_categories WHERE id = $1", [id]);
    if (!current.rowCount) throw new AppError(404, "CATEGORY_NOT_FOUND", "Category was not found.");
    const row = current.rows[0];
    const input = categoryInput({ name: req.body.name ?? row.name, slug: req.body.slug ?? row.slug,
      description: req.body.description ?? row.description, displayOrder: req.body.displayOrder ?? row.display_order,
      isActive: req.body.isActive ?? row.is_active });
    await ensureUniqueCategorySlug(database, input.slug, id);
    if (!input.isActive) {
      const dependent = await database.query("SELECT COUNT(*)::integer AS count FROM menu_items WHERE category_id = $1 AND is_active", [id]);
      if (dependent.rows[0].count) throw new AppError(409, "CATEGORY_IN_USE", "Archive or move active menu items before deactivating this category.");
    }
    const result = await database.query(`UPDATE menu_categories SET name=$2,slug=$3,description=$4,display_order=$5,is_active=$6
      WHERE id=$1 RETURNING *`, [id, input.name, input.slug, input.description, input.displayOrder, input.isActive]);
    await audit(database, req, "CATEGORY_UPDATED", "menu_category", String(id));
    res.json({ category: result.rows[0] });
  }));

  router.delete("/categories/:id", asyncRoute(async (req, res) => {
    const id = validation.integer(req.params.id, "id", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    const dependent = await database.query("SELECT COUNT(*)::integer AS count FROM menu_items WHERE category_id = $1", [id]);
    if (dependent.rows[0].count) throw new AppError(409, "CATEGORY_IN_USE", "Categories with menu history cannot be deleted. Deactivate it instead.");
    const result = await database.query("DELETE FROM menu_categories WHERE id = $1 RETURNING id", [id]);
    if (!result.rowCount) throw new AppError(404, "CATEGORY_NOT_FOUND", "Category was not found.");
    await audit(database, req, "CATEGORY_DELETED", "menu_category", String(id));
    res.status(204).end();
  }));

  router.get("/orders", asyncRoute(async (req, res) => {
    const params = [];
    const where = [];
    if (req.query.search) { params.push(`%${String(req.query.search).slice(0, 120)}%`); where.push(`(o.public_order_number ILIKE $${params.length} OR o.customer_name ILIKE $${params.length} OR o.customer_phone ILIKE $${params.length})`); }
    if (req.query.status) { if (!new Set(["PENDING","CONFIRMED","READY","COMPLETED","CANCELLED"]).has(req.query.status)) throw new AppError(422,"VALIDATION_ERROR","Invalid order status."); if (req.query.status === "CONFIRMED") where.push("o.status IN ('CONFIRMED','PREPARING')"); else { params.push(req.query.status); where.push(`o.status = $${params.length}`); } }
    if (req.query.orderType) { if (!new Set(["DINE_IN","TAKEOUT"]).has(req.query.orderType)) throw new AppError(422,"VALIDATION_ERROR","Invalid order type."); params.push(req.query.orderType); where.push(`o.order_type = $${params.length}`); }
    if (req.query.paymentStatus) { if (!new Set(["DUE_ON_SITE","PAID_ON_SITE"]).has(req.query.paymentStatus)) throw new AppError(422,"VALIDATION_ERROR","Invalid payment status."); params.push(req.query.paymentStatus); where.push(`o.payment_status = $${params.length}`); }
    if (req.query.dateRange) {
      const range = String(req.query.dateRange);
      const days = { today: 0, yesterday: 1, "7d": 6, "30d": 29 }[range];
      if (days === undefined) throw new AppError(422, "VALIDATION_ERROR", "Invalid date range.");
      if (range === "yesterday") where.push("o.created_at >= CURRENT_DATE - INTERVAL '1 day' AND o.created_at < CURRENT_DATE");
      else { params.push(days); where.push(`o.created_at >= CURRENT_DATE - ($${params.length} * INTERVAL '1 day')`); }
    }
    if (req.query.startDate || req.query.endDate) {
      if (req.query.startDate) { params.push(validation.text(req.query.startDate, "startDate", { max: 10 })); where.push(`o.created_at >= $${params.length}::date`); }
      if (req.query.endDate) { params.push(validation.text(req.query.endDate, "endDate", { max: 10 })); where.push(`o.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    }
    const direction = req.query.sort === "oldest" ? "ASC" : "DESC";
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const result = await database.query(`SELECT o.public_order_number, o.daily_ticket_number, o.customer_name, o.customer_phone, o.order_type,
      o.requested_at, o.estimated_ready_at, o.total_cents, o.status, o.payment_status, o.created_at, COALESCE(SUM(oi.quantity),0)::integer AS item_count
      FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id ${clause} GROUP BY o.id
      ORDER BY CASE WHEN o.status IN ('PENDING','CONFIRMED','PREPARING','READY') THEN 0 ELSE 1 END,
        CASE WHEN o.status IN ('PENDING','CONFIRMED','PREPARING','READY') THEN COALESCE(o.estimated_ready_at,o.requested_at) END ASC NULLS LAST,
        CASE WHEN o.status NOT IN ('PENDING','CONFIRMED','PREPARING','READY') THEN o.created_at END ${direction} NULLS LAST LIMIT 200`, params);
    res.json({ orders: result.rows.map((row) => ({ orderNumber: row.public_order_number, ticketNumber: row.daily_ticket_number, customerName: row.customer_name,
      customerPhone: row.customer_phone, orderType: row.order_type, placedAt: row.created_at, requestedAt: row.requested_at, readyBy: row.estimated_ready_at || row.requested_at,
      totalCents: row.total_cents, status: row.status, paymentStatus: row.payment_status,
      createdAt: row.created_at, itemCount: row.item_count })) });
  }));

  router.get("/kitchen", asyncRoute(async (req, res) => {
    const result = await database.query(`SELECT o.id, o.public_order_number, o.daily_ticket_number, o.customer_name, o.customer_phone,
      o.order_type, o.requested_at, o.estimated_ready_at, o.total_cents, o.status, o.customer_instructions, o.created_at, o.updated_at,
      COALESCE(json_agg(json_build_object(
        'name', oi.item_name_snapshot,
        'quantity', oi.quantity,
        'notes', oi.customer_item_notes,
        'modifiers', COALESCE((SELECT json_agg(json_build_object(
          'groupName', oim.group_name_snapshot,
          'optionName', oim.option_name_snapshot,
          'priceDeltaCents', oim.price_delta_cents
        ) ORDER BY oim.id) FROM order_item_modifiers oim WHERE oim.order_item_id=oi.id), '[]'::json)
      ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]'::json) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status IN ('PENDING','CONFIRMED','PREPARING','READY')
      GROUP BY o.id
      ORDER BY CASE o.status WHEN 'READY' THEN 1 WHEN 'PREPARING' THEN 2 WHEN 'CONFIRMED' THEN 3 ELSE 4 END,
        COALESCE(o.estimated_ready_at,o.requested_at) ASC NULLS LAST, o.created_at ASC`);
    res.json({ orders: result.rows.map((row) => ({
      orderNumber: row.public_order_number, ticketNumber: row.daily_ticket_number, customerName: row.customer_name,
      customerPhone: row.customer_phone, orderType: row.order_type,
      placedAt: row.created_at, requestedAt: row.requested_at, readyBy: row.estimated_ready_at || row.requested_at, totalCents: row.total_cents,
      status: row.status, customerInstructions: row.customer_instructions,
      createdAt: row.created_at, updatedAt: row.updated_at, items: row.items
    })) });
  }));

  router.get("/orders/:orderNumber", asyncRoute(async (req, res) => {
    const result = await database.query(`SELECT * FROM orders WHERE public_order_number = $1`, [req.params.orderNumber]);
    if (!result.rowCount) throw new AppError(404, "ORDER_NOT_FOUND", "Order was not found.");
    const order = result.rows[0];
    const [items, modifiers, history, notes, adjustments] = await Promise.all([
      effectiveOrderItems(database, order.id),
      database.query(`SELECT oim.order_item_id,oim.group_name_snapshot,oim.option_name_snapshot,oim.price_delta_cents
        FROM order_item_modifiers oim JOIN order_items oi ON oi.id=oim.order_item_id
        WHERE oi.order_id=$1 ORDER BY oim.order_item_id,oim.id`, [order.id]),
      database.query("SELECT previous_status,new_status,actor_type,reason,created_at FROM order_status_history WHERE order_id=$1 ORDER BY created_at,id", [order.id]),
      database.query("SELECT note_text,visibility,created_at FROM order_notes WHERE order_id=$1 ORDER BY created_at,id", [order.id]),
      database.query("SELECT line_key,operation,reason,created_at FROM order_item_adjustments WHERE order_id=$1 ORDER BY id", [order.id])
    ]);
    const modifiersByItem = new Map();
    for (const modifier of modifiers.rows) {
      const key = String(modifier.order_item_id);
      if (!modifiersByItem.has(key)) modifiersByItem.set(key, []);
      modifiersByItem.get(key).push(modifier);
    }
    res.json({ order: { orderNumber: order.public_order_number, ticketNumber: order.daily_ticket_number, customerName: order.customer_name,
      customerPhone: order.customer_phone, customerEmail: order.customer_email, orderType: order.order_type,
      placedAt: order.created_at, requestedAt: order.requested_at, readyBy: order.estimated_ready_at || order.requested_at, status: order.status, subtotalCents: order.subtotal_cents,
      taxCents: order.tax_cents, totalCents: order.total_cents, paymentMethod: order.payment_method,
      paymentStatus: order.payment_status, customerInstructions: order.customer_instructions,
      createdAt: order.created_at, updatedAt: order.updated_at,
      items: items.map((item) => ({ ...item, modifiers: modifiersByItem.get(String(item.modifierSourceId)) || [] })),
      history: history.rows, notes: notes.rows, adjustments: adjustments.rows } });
  }));

  router.get("/orders/:orderNumber/menu", asyncRoute(async (req, res) => {
    const order = await database.query("SELECT id FROM orders WHERE public_order_number=$1", [req.params.orderNumber]);
    if (!order.rowCount) throw new AppError(404, "ORDER_NOT_FOUND", "Order was not found.");
    const menu = await database.query(`SELECT i.id,i.name,i.description,i.price_cents,c.name AS category_name,c.id AS category_id
      FROM menu_items i JOIN menu_categories c ON c.id=i.category_id
      WHERE i.is_active AND i.is_available AND c.is_active ORDER BY c.display_order,c.id,i.display_order,i.id`);
    res.json({ items: menu.rows.map((item) => ({ id: String(item.id), name: item.name, description: item.description, priceCents: item.price_cents, categoryId: String(item.category_id), categoryName: item.category_name })) });
  }));

  router.patch("/orders/:orderNumber/customer", asyncRoute(async (req, res) => {
    const input = {
      customerName: validation.text(req.body.customerName, "customerName", { max: 160 }),
      customerPhone: validation.text(req.body.customerPhone, "customerPhone", { max: 80 }),
      customerEmail: validation.text(req.body.customerEmail, "customerEmail", { required: false, max: 254 }),
      customerInstructions: validation.text(req.body.customerInstructions ?? "", "customerInstructions", { required: false, max: 3000 })
    };
    const client = await database.connect();
    try {
      await client.query("BEGIN"); const order = await activeOrderForUpdate(client, req.params.orderNumber);
      await client.query(`UPDATE orders SET customer_name=$2,customer_phone=$3,customer_email=$4,customer_instructions=$5 WHERE id=$1`, [order.id, input.customerName, input.customerPhone, input.customerEmail || null, input.customerInstructions]);
      await client.query("COMMIT"); await audit(database, req, "ORDER_CUSTOMER_UPDATED", "order", req.params.orderNumber);
      res.json({ orderNumber: req.params.orderNumber });
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  }));

  router.post("/orders/:orderNumber/items", asyncRoute(async (req, res) => {
    const menuItemId = validation.integer(req.body.menuItemId, "menuItemId", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    const quantity = validation.integer(req.body.quantity ?? 1, "quantity", { minimum: 1, maximum: 99 });
    const notes = validation.text(req.body.notes ?? "", "notes", { required: false, max: 2000 });
    const lineKey = `added-${require("node:crypto").randomUUID()}`;
    const client = await database.connect();
    try {
      await client.query("BEGIN"); const order = await activeOrderForUpdate(client, req.params.orderNumber); const item = await availableMenuItem(client, menuItemId);
      const reservedQuantity = item.inventory_mode === INVENTORY_MODES.QUANTITY_TRACKED ? quantity : 0;
      if (reservedQuantity) await applyInventoryDeltas(client, [{ menuItemId: item.id, delta: reservedQuantity }]);
      await client.query(`INSERT INTO order_item_adjustments (order_id,line_key,operation,menu_item_id,item_name_snapshot,description_snapshot,unit_price_cents,quantity,customer_item_notes,reason,actor_user_id,inventory_reserved_quantity)
        VALUES ($1,$2,'UPSERT',$3,$4,$5,$6,$7,$8,'ITEM_ADDED',$9,$10)`, [order.id, lineKey, item.id, item.name, item.description, item.price_cents, quantity, notes, req.admin.id, reservedQuantity]);
      await refreshOrderTotals(client, order.id); await client.query("COMMIT"); await audit(database, req, "ORDER_ITEM_ADDED", "order", req.params.orderNumber, { menuItemId, quantity });
      res.status(201).json({ lineKey });
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  }));

  router.patch("/orders/:orderNumber/items/:lineKey", asyncRoute(async (req, res) => {
    const lineKey = validation.text(req.params.lineKey, "lineKey", { max: 200 });
    const quantity = req.body.quantity == null ? null : validation.integer(req.body.quantity, "quantity", { minimum: 1, maximum: 99 });
    const notes = req.body.notes == null ? null : validation.text(req.body.notes, "notes", { required: false, max: 2000 });
    const replacementMenuItemId = req.body.replacementMenuItemId == null ? null : validation.integer(req.body.replacementMenuItemId, "replacementMenuItemId", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    const overridePriceCents = req.body.overridePriceCents == null || req.body.overridePriceCents === "" ? null : validation.integer(req.body.overridePriceCents, "overridePriceCents", { minimum: 0, maximum: 1000000 });
    const reason = validation.text(req.body.reason ?? "", "reason", { required: false, max: 500 });
    if (overridePriceCents != null && !reason) throw new AppError(422, "PRICE_OVERRIDE_REASON_REQUIRED", "A price override reason is required.", { field: "reason" });
    const client = await database.connect();
    try {
      await client.query("BEGIN"); const order = await activeOrderForUpdate(client, req.params.orderNumber); const lines = await effectiveOrderItems(client, order.id); const current = lines.find((line) => line.lineKey === lineKey);
      if (!current) throw new AppError(404, "ORDER_ITEM_NOT_FOUND", "Order item was not found.");
      let replacement = null; if (replacementMenuItemId) replacement = await availableMenuItem(client, replacementMenuItemId);
      const targetItem = replacement || (await client.query("SELECT id,name,inventory_mode,available_quantity,is_available FROM menu_items WHERE id=$1 FOR UPDATE", [current.menu_item_id])).rows[0];
      if (!targetItem) throw new AppError(409, "MENU_ITEM_UNAVAILABLE", "The current menu item no longer exists.");
      const finalQuantity = quantity ?? current.quantity;
      const reservedQuantity = targetItem.inventory_mode === INVENTORY_MODES.QUANTITY_TRACKED ? finalQuantity : 0;
      const deltas = replacement && String(replacement.id) !== String(current.menu_item_id)
        ? [{ menuItemId: current.menu_item_id, delta: -Number(current.inventory_reserved_quantity || 0) }, { menuItemId: replacement.id, delta: reservedQuantity }]
        : [{ menuItemId: current.menu_item_id, delta: reservedQuantity - Number(current.inventory_reserved_quantity || 0) }];
      await applyInventoryDeltas(client, deltas);
      const unitPrice = overridePriceCents ?? (replacement ? replacement.price_cents : current.unit_price_cents);
      const modifierPrice = replacement ? 0 : current.modifier_total_cents;
      await client.query(`INSERT INTO order_item_adjustments (order_id,line_key,operation,base_order_item_id,menu_item_id,item_name_snapshot,description_snapshot,unit_price_cents,modifier_total_cents,quantity,customer_item_notes,reason,actor_user_id,inventory_reserved_quantity)
        VALUES ($1,$2,'UPSERT',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [order.id,lineKey,current.modifierSourceId || null,replacement?.id || current.menu_item_id,replacement?.name || current.item_name_snapshot,replacement?.description || current.description_snapshot,unitPrice,modifierPrice,finalQuantity,notes ?? current.customer_item_notes,reason || (replacement ? "ITEM_REPLACED" : "ITEM_UPDATED"),req.admin.id,reservedQuantity]);
      await refreshOrderTotals(client, order.id); await client.query("COMMIT"); await audit(database, req, overridePriceCents != null ? "ORDER_PRICE_OVERRIDDEN" : replacement ? "ORDER_ITEM_REPLACED" : "ORDER_ITEM_UPDATED", "order", req.params.orderNumber, { lineKey, reason });
      res.json({ lineKey });
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  }));

  router.delete("/orders/:orderNumber/items/:lineKey", asyncRoute(async (req, res) => {
    const lineKey = validation.text(req.params.lineKey, "lineKey", { max: 200 }); const client = await database.connect();
    try {
      await client.query("BEGIN"); const order = await activeOrderForUpdate(client, req.params.orderNumber); const lines = await effectiveOrderItems(client, order.id);
      if (!lines.some((line) => line.lineKey === lineKey)) throw new AppError(404, "ORDER_ITEM_NOT_FOUND", "Order item was not found.");
      if (lines.length <= 1) throw new AppError(409, "ORDER_REQUIRES_ITEM", "Cancel the order instead of removing its final item.");
      const current = lines.find((line) => line.lineKey === lineKey);
      if (Number(current.inventory_reserved_quantity) > 0) await applyInventoryDeltas(client, [{ menuItemId: current.menu_item_id, delta: -Number(current.inventory_reserved_quantity) }]);
      await client.query(`INSERT INTO order_item_adjustments (order_id,line_key,operation,reason,actor_user_id) VALUES ($1,$2,'REMOVE','ITEM_REMOVED',$3)`, [order.id,lineKey,req.admin.id]);
      await refreshOrderTotals(client, order.id); await client.query("COMMIT"); await audit(database, req, "ORDER_ITEM_REMOVED", "order", req.params.orderNumber, { lineKey });
      res.status(204).end();
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  }));

  router.post("/orders/:orderNumber/transition", asyncRoute(async (req, res) => {
    const nextStatus = validation.text(req.body.status, "status", { max: 20 }).toUpperCase();
    const reason = validation.text(req.body.reason, "reason", { required: false, max: 500 });
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query("SELECT id,status,inventory_restored_at FROM orders WHERE public_order_number=$1 FOR UPDATE", [req.params.orderNumber]);
      if (!current.rowCount) throw new AppError(404, "ORDER_NOT_FOUND", "Order was not found.");
      if (!canTransition(current.rows[0].status, nextStatus)) throw new AppError(409, "INVALID_STATUS_TRANSITION", `Cannot move an order from ${current.rows[0].status} to ${nextStatus}.`);
      if (nextStatus === "CANCELLED" && !reason) throw new AppError(422, "CANCELLATION_REASON_REQUIRED", "A cancellation reason is required.", { field: "reason" });
      if (nextStatus === "CANCELLED") await restoreOrderInventory(client, current.rows[0]);
      await client.query("UPDATE orders SET status=$2 WHERE id=$1", [current.rows[0].id, nextStatus]);
      await client.query(`INSERT INTO order_status_history (order_id,previous_status,new_status,actor_type,actor_user_id,reason)
        VALUES ($1,$2,$3,$4,$5,$6)`, [current.rows[0].id, current.rows[0].status, nextStatus, req.admin.role, req.admin.id, reason]);
      await client.query("COMMIT");
      await audit(database, req, "ORDER_STATUS_CHANGED", "order", req.params.orderNumber, { from: current.rows[0].status, to: nextStatus });
      pushNotifications.sendStatusChanged({ orderNumber: req.params.orderNumber, status: nextStatus })
        .catch((error) => console.error("[push] status delivery failed", error.message));
      res.json({ orderNumber: req.params.orderNumber, status: nextStatus });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }));

  router.patch("/orders/:orderNumber/timing", asyncRoute(async (req, res) => {
    const estimatedReadyAt = new Date(validation.text(req.body.estimatedReadyAt, "estimatedReadyAt", { max: 64 }));
    if (Number.isNaN(estimatedReadyAt.valueOf())) throw new AppError(422, "VALIDATION_ERROR", "Estimated ready must be a valid date and time.", { field: "estimatedReadyAt" });
    const client = await database.connect(); let result;
    try { await client.query("BEGIN"); const order = await activeOrderForUpdate(client, req.params.orderNumber);
      result = await client.query("UPDATE orders SET estimated_ready_at=$2 WHERE id=$1 RETURNING public_order_number,estimated_ready_at", [order.id, estimatedReadyAt]); await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
    await audit(database, req, "ORDER_ESTIMATED_READY_UPDATED", "order", req.params.orderNumber, { estimatedReadyAt: result.rows[0].estimated_ready_at });
    res.json({ orderNumber: result.rows[0].public_order_number, estimatedReadyAt: result.rows[0].estimated_ready_at });
  }));

  router.post("/orders/:orderNumber/notes", asyncRoute(async (req, res) => {
    const noteText = validation.text(req.body.note, "note", { max: 2000 });
    const visibility = validation.text(req.body.visibility, "visibility", { max: 20 }).toUpperCase();
    if (!new Set(["INTERNAL", "CUSTOMER"]).has(visibility)) throw new AppError(422, "VALIDATION_ERROR", "Visibility must be INTERNAL or CUSTOMER.");
    const result = await database.query(`INSERT INTO order_notes (order_id,note_text,visibility,actor_user_id)
      SELECT id,$2,$3,$4 FROM orders WHERE public_order_number=$1 RETURNING id,created_at`, [req.params.orderNumber, noteText, visibility, req.admin.id]);
    if (!result.rowCount) throw new AppError(404, "ORDER_NOT_FOUND", "Order was not found.");
    await audit(database, req, "ORDER_NOTE_ADDED", "order", req.params.orderNumber, { visibility });
    res.status(201).json({ note: { text: noteText, visibility, createdAt: result.rows[0].created_at } });
  }));

  router.post("/orders/:orderNumber/payment", asyncRoute(async (req, res) => {
    if (req.body.paymentStatus !== "PAID_ON_SITE") throw new AppError(422, "VALIDATION_ERROR", "Payment status may only be recorded as PAID_ON_SITE.");
    const result = await database.query("UPDATE orders SET payment_status='PAID_ON_SITE' WHERE public_order_number=$1 RETURNING public_order_number", [req.params.orderNumber]);
    if (!result.rowCount) throw new AppError(404, "ORDER_NOT_FOUND", "Order was not found.");
    await audit(database, req, "ORDER_PAYMENT_RECORDED", "order", req.params.orderNumber, { paymentStatus: "PAID_ON_SITE" });
    res.json({ orderNumber: req.params.orderNumber, paymentStatus: "PAID_ON_SITE" });
  }));

  router.get("/specials", asyncRoute(async (req, res) => {
    const result = await database.query("SELECT * FROM daily_specials ORDER BY display_order,id");
    res.json({ specials: result.rows });
  }));

  router.post("/specials", uploadMiddleware(config), asyncRoute(async (req, res) => {
    let imagePath;
    try {
      const input = specialInput(req.body);
      imagePath = await finalizeImage(req.file, config);
      const result = await database.query(`INSERT INTO daily_specials (title,description,price_cents,day_label,active_from,active_until,image_path,image_alt_text,display_order,is_active,is_sold_out)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [input.title,input.description,input.priceCents,input.dayLabel,input.activeFrom,input.activeUntil,imagePath,input.imageAlt,input.displayOrder,input.isActive,input.isSoldOut]);
      await audit(database, req, "SPECIAL_CREATED", "daily_special", String(result.rows[0].id));
      res.status(201).json({ special: result.rows[0] });
    } catch (error) { if (imagePath) await removeUploadedImage(imagePath, config).catch(() => {}); throw error; }
  }));

  router.patch("/specials/:id", uploadMiddleware(config), asyncRoute(async (req, res) => {
    const id = validation.integer(req.params.id,"id",{minimum:1,maximum:Number.MAX_SAFE_INTEGER});
    const current = await database.query("SELECT * FROM daily_specials WHERE id=$1",[id]);
    if (!current.rowCount) throw new AppError(404,"SPECIAL_NOT_FOUND","Daily special was not found.");
    const row=current.rows[0];
    let uploadedImagePath;
    try {
      const input=specialInput({title:req.body.title??row.title,description:req.body.description??row.description,priceCents:req.body.priceCents??row.price_cents,dayLabel:req.body.dayLabel??row.day_label,activeFrom:req.body.activeFrom??row.active_from?.toISOString?.().slice(0,10)??row.active_from,activeUntil:req.body.activeUntil??row.active_until?.toISOString?.().slice(0,10)??row.active_until,imageAlt:req.body.imageAlt??row.image_alt_text,displayOrder:req.body.displayOrder??row.display_order,isActive:req.body.isActive??row.is_active,isSoldOut:req.body.isSoldOut??row.is_sold_out});
      uploadedImagePath=await finalizeImage(req.file,config);
      const removeImage=req.body.removeImage===true||req.body.removeImage==="true";
      const finalImagePath=removeImage?null:uploadedImagePath||row.image_path;
      const result=await database.query(`UPDATE daily_specials SET title=$2,description=$3,price_cents=$4,day_label=$5,active_from=$6,active_until=$7,image_path=$8,image_alt_text=$9,display_order=$10,is_active=$11,is_sold_out=$12 WHERE id=$1 RETURNING *`,[id,input.title,input.description,input.priceCents,input.dayLabel,input.activeFrom,input.activeUntil,finalImagePath,input.imageAlt,input.displayOrder,input.isActive,input.isSoldOut]);
      if(row.image_path&&row.image_path!==finalImagePath) await removeUploadedImage(row.image_path,config).catch(()=>{});
      await audit(database,req,"SPECIAL_UPDATED","daily_special",String(id),{imageChanged:row.image_path!==finalImagePath});
      res.json({special:result.rows[0]});
    } catch(error){if(uploadedImagePath)await removeUploadedImage(uploadedImagePath,config).catch(()=>{});throw error;}
  }));

  router.delete("/specials/:id", asyncRoute(async (req,res)=>{
    const id=validation.integer(req.params.id,"id",{minimum:1,maximum:Number.MAX_SAFE_INTEGER});
    const result=await database.query("UPDATE daily_specials SET is_active=FALSE WHERE id=$1 RETURNING id",[id]);
    if(!result.rowCount) throw new AppError(404,"SPECIAL_NOT_FOUND","Daily special was not found.");
    await audit(database,req,"SPECIAL_DEACTIVATED","daily_special",String(id)); res.status(204).end();
  }));

  router.get("/gallery", asyncRoute(async (req,res)=>res.json({gallery:(await database.query("SELECT * FROM gallery_items ORDER BY display_order,id")).rows})));
  router.post("/gallery", uploadMiddleware(config), asyncRoute(async (req,res)=>{
    let imagePath;
    try {
      if(!req.file) throw new AppError(422,"IMAGE_REQUIRED","Choose a gallery image.");
      const altText=validation.text(req.body.altText,"altText",{max:300});
      const caption=validation.text(req.body.caption,"caption",{required:false,max:500});
      const category=validation.text(req.body.category??"food","category",{max:20}).toLowerCase();
      if(!new Set(["food","lounge","facility"]).has(category)) throw new AppError(422,"VALIDATION_ERROR","Gallery category must be food, lounge, or facility.",{field:"category"});
      const displayOrder=validation.integer(req.body.displayOrder??0,"displayOrder",{minimum:0,maximum:100000});
      const isActive=validation.boolean(req.body.isActive??true,"isActive");
      imagePath=await finalizeImage(req.file,config);
      const result=await database.query("INSERT INTO gallery_items (image_path,alt_text,caption,category,display_order,is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",[imagePath,altText,caption,category,displayOrder,isActive]);
      await audit(database,req,"GALLERY_ITEM_CREATED","gallery_item",String(result.rows[0].id)); res.status(201).json({item:result.rows[0]});
    } catch(error){if(imagePath) await removeUploadedImage(imagePath,config).catch(()=>{}); throw error;}
  }));
  router.patch("/gallery/:id", asyncRoute(async (req,res)=>{
    const id=validation.integer(req.params.id,"id",{minimum:1,maximum:Number.MAX_SAFE_INTEGER});
    const current=await database.query("SELECT * FROM gallery_items WHERE id=$1",[id]); if(!current.rowCount) throw new AppError(404,"GALLERY_ITEM_NOT_FOUND","Gallery item was not found.");
    const row=current.rows[0]; const altText=validation.text(req.body.altText??row.alt_text,"altText",{max:300}); const caption=validation.text(req.body.caption??row.caption,"caption",{required:false,max:500}); const category=validation.text(req.body.category??row.category??"food","category",{max:20}).toLowerCase(); const displayOrder=validation.integer(req.body.displayOrder??row.display_order,"displayOrder",{minimum:0,maximum:100000}); const isActive=validation.boolean(req.body.isActive??row.is_active,"isActive");
    if(!new Set(["food","lounge","facility"]).has(category)) throw new AppError(422,"VALIDATION_ERROR","Gallery category must be food, lounge, or facility.",{field:"category"});
    const result=await database.query("UPDATE gallery_items SET alt_text=$2,caption=$3,category=$4,display_order=$5,is_active=$6 WHERE id=$1 RETURNING *",[id,altText,caption,category,displayOrder,isActive]); await audit(database,req,"GALLERY_ITEM_UPDATED","gallery_item",String(id)); res.json({item:result.rows[0]});
  }));
  router.delete("/gallery/:id", asyncRoute(async (req,res)=>{
    const id=validation.integer(req.params.id,"id",{minimum:1,maximum:Number.MAX_SAFE_INTEGER}); const current=await database.query("SELECT image_path FROM gallery_items WHERE id=$1",[id]); if(!current.rowCount) throw new AppError(404,"GALLERY_ITEM_NOT_FOUND","Gallery item was not found."); await database.query("DELETE FROM gallery_items WHERE id=$1",[id]); await removeUploadedImage(current.rows[0].image_path,config); await audit(database,req,"GALLERY_ITEM_DELETED","gallery_item",String(id)); res.status(204).end();
  }));

  router.get("/hours-contact", asyncRoute(async (req,res)=>{
    const [hours,settings,exceptions]=await Promise.all([database.query("SELECT * FROM business_hours ORDER BY display_order"),database.query("SELECT * FROM site_settings WHERE id=1"),database.query("SELECT * FROM business_exceptions ORDER BY exception_date,id")]); res.json({hours:hours.rows,settings:settings.rows[0],exceptions:exceptions.rows});
  }));

  router.post("/hours-exceptions", asyncRoute(async (req,res)=>{
    const exceptionDate=validation.text(req.body.exceptionDate,"exceptionDate",{max:10});
    if(!/^\d{4}-\d{2}-\d{2}$/.test(exceptionDate)) throw new AppError(422,"VALIDATION_ERROR","Exception date must use YYYY-MM-DD.",{field:"exceptionDate"});
    const isClosed=validation.boolean(req.body.isClosed??true,"isClosed");
    const opensAt=isClosed?null:validation.text(req.body.opensAt,"opensAt",{max:8});
    const closesAt=isClosed?null:validation.text(req.body.closesAt,"closesAt",{max:8});
    const label=validation.text(req.body.label,"label",{required:false,max:120});
    if(!isClosed&&(!/^\d{2}:\d{2}/.test(opensAt)||!/^\d{2}:\d{2}/.test(closesAt))) throw new AppError(422,"VALIDATION_ERROR","Opening and closing times are required.");
    const result=await database.query(`INSERT INTO business_exceptions (exception_date,opens_at,closes_at,is_closed,label)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (exception_date) DO UPDATE SET opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,is_closed=EXCLUDED.is_closed,label=EXCLUDED.label
      RETURNING *`,[exceptionDate,opensAt,closesAt,isClosed,label]);
    await audit(database,req,"BUSINESS_EXCEPTION_SAVED","business_exception",String(result.rows[0].id));
    res.status(201).json({exception:result.rows[0]});
  }));

  router.delete("/hours-exceptions/:id", asyncRoute(async (req,res)=>{
    const id=validation.integer(req.params.id,"id",{minimum:1,maximum:Number.MAX_SAFE_INTEGER});
    const result=await database.query("DELETE FROM business_exceptions WHERE id=$1 RETURNING id",[id]);
    if(!result.rowCount) throw new AppError(404,"EXCEPTION_NOT_FOUND","Hours exception was not found.");
    await audit(database,req,"BUSINESS_EXCEPTION_DELETED","business_exception",String(id));
    res.status(204).end();
  }));
  router.put("/hours-contact", asyncRoute(async (req,res)=>{
    if(!Array.isArray(req.body.hours)||req.body.hours.length!==7) throw new AppError(422,"VALIDATION_ERROR","Provide all seven days of business hours.",{field:"hours"});
    const client=await database.connect(); try{await client.query("BEGIN"); for(const raw of req.body.hours){const day=validation.integer(raw.dayOfWeek,"dayOfWeek",{minimum:0,maximum:6});const isClosed=validation.boolean(raw.isClosed,"isClosed");const opensAt=isClosed?null:validation.text(raw.opensAt,"opensAt",{max:8});const closesAt=isClosed?null:validation.text(raw.closesAt,"closesAt",{max:8});if(!isClosed&&(!/^\d{2}:\d{2}/.test(opensAt)||!/^\d{2}:\d{2}/.test(closesAt)))throw new AppError(422,"VALIDATION_ERROR","Opening and closing times are required.");await client.query("UPDATE business_hours SET opens_at=$2,closes_at=$3,is_closed=$4 WHERE day_of_week=$1",[day,opensAt,closesAt,isClosed]);}await client.query("COMMIT");}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
    await audit(database,req,"BUSINESS_HOURS_UPDATED","site_settings","1"); res.json({ok:true});
  }));

  router.get("/settings", asyncRoute(async (req,res)=>res.json({settings:(await database.query("SELECT * FROM site_settings WHERE id=1")).rows[0]})));
  router.put("/settings", asyncRoute(async (req,res)=>{
    const currentResult = await database.query("SELECT * FROM site_settings WHERE id=1");
    if(!currentResult.rowCount) throw new AppError(409,"SETTINGS_NOT_INITIALIZED","Site settings have not been initialized. Run database migrations.");
    const current=currentResult.rows[0];
    const fields={businessName:validation.text(req.body.businessName??current.business_name,"businessName",{max:200}),heroTitle:validation.text(req.body.heroTitle??current.hero_title,"heroTitle",{max:200}),heroSubtitle:validation.text(req.body.heroSubtitle??current.hero_subtitle,"heroSubtitle",{max:1000}),address:validation.text(req.body.address??current.address,"address",{max:500}),phone:validation.text(req.body.phone??current.phone,"phone",{required:false,max:50}),email:validation.optionalEmail(req.body.email??current.email)||"",mapUrl:validation.text(req.body.mapUrl??current.map_url,"mapUrl",{required:false,max:1000}),parentSiteUrl:validation.text(req.body.parentSiteUrl??current.parent_site_url,"parentSiteUrl",{required:false,max:1000}),dineInWording:validation.text(req.body.dineInWording??current.dine_in_wording,"dineInWording",{max:1000}),takeoutWording:validation.text(req.body.takeoutWording??current.takeout_wording,"takeoutWording",{max:1000}),truckParkingWording:validation.text(req.body.truckParkingWording??current.truck_parking_wording,"truckParkingWording",{max:1000}),familyFriendlyWording:validation.text(req.body.familyFriendlyWording??current.family_friendly_wording,"familyFriendlyWording",{max:1000}),orderPaymentInstructions:validation.text(req.body.orderPaymentInstructions??current.order_payment_instructions,"orderPaymentInstructions",{max:1000}),showUnavailableItems:req.body.showUnavailableItems == null ? current.show_unavailable_items : validation.boolean(req.body.showUnavailableItems,"showUnavailableItems"),timezone:validation.text(req.body.timezone??current.timezone??"America/Chicago","timezone",{max:100}),publicDescription:validation.text(req.body.publicDescription??current.public_description,"publicDescription",{required:false,max:2000}),pickupInstructions:validation.text(req.body.pickupInstructions??current.pickup_instructions,"pickupInstructions",{required:false,max:1000}),dineInEnabled:req.body.dineInEnabled==null?current.dine_in_enabled:validation.boolean(req.body.dineInEnabled,"dineInEnabled"),takeoutEnabled:req.body.takeoutEnabled==null?current.takeout_enabled:validation.boolean(req.body.takeoutEnabled,"takeoutEnabled"),acceptingOrders:req.body.acceptingOrders==null?current.accepting_orders:validation.boolean(req.body.acceptingOrders,"acceptingOrders")};
    const result=await database.query(`UPDATE site_settings SET business_name=$1,hero_title=$2,hero_subtitle=$3,address=$4,phone=$5,email=$6,map_url=$7,parent_site_url=$8,dine_in_wording=$9,takeout_wording=$10,truck_parking_wording=$11,family_friendly_wording=$12,order_payment_instructions=$13,show_unavailable_items=$14,timezone=$15,public_description=$16,pickup_instructions=$17,dine_in_enabled=$18,takeout_enabled=$19,accepting_orders=$20,version=version+1,updated_at=NOW() WHERE id=1 RETURNING *`,Object.values(fields)); await audit(database,req,"SITE_SETTINGS_UPDATED","site_settings","1"); res.json({settings:result.rows[0]});
  }));

  router.get("/users", requireOwner, asyncRoute(async (req,res)=>{const result=await database.query("SELECT id,email,display_name,role,is_active,last_login_at,created_at FROM admin_users ORDER BY role,email");res.json({users:result.rows.map(row=>({...row,id:String(row.id)}))});}));
  router.post("/users", requireOwner, asyncRoute(async (req,res)=>{
    const email=validation.optionalEmail(req.body.email);if(!email)throw new AppError(422,"VALIDATION_ERROR","Email is required.",{field:"email"});const displayName=validation.text(req.body.displayName,"displayName",{max:160});const password=validation.text(req.body.password,"password",{max:200});if(password.length<12)throw new AppError(422,"WEAK_PASSWORD","Password must be at least 12 characters.",{field:"password"});const role=validation.text(req.body.role,"role",{max:10}).toUpperCase();if(!new Set(["OWNER","STAFF"]).has(role))throw new AppError(422,"VALIDATION_ERROR","Role must be OWNER or STAFF.");const hash=await bcrypt.hash(password,12);const result=await database.query("INSERT INTO admin_users (email,display_name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,email,display_name,role,is_active,created_at",[email.toLowerCase(),displayName,hash,role]);await audit(database,req,"ADMIN_USER_CREATED","admin_user",String(result.rows[0].id),{role});res.status(201).json({user:{...result.rows[0],id:String(result.rows[0].id)}});
  }));
  router.patch("/users/:id", requireOwner, asyncRoute(async (req,res)=>{
    const id=validation.integer(req.params.id,"id",{minimum:1,maximum:Number.MAX_SAFE_INTEGER});const current=await database.query("SELECT id,role,is_active FROM admin_users WHERE id=$1",[id]);if(!current.rowCount)throw new AppError(404,"USER_NOT_FOUND","User was not found.");const role=req.body.role?validation.text(req.body.role,"role",{max:10}).toUpperCase():current.rows[0].role;const isActive=req.body.isActive==null?current.rows[0].is_active:validation.boolean(req.body.isActive,"isActive");if(!new Set(["OWNER","STAFF"]).has(role))throw new AppError(422,"VALIDATION_ERROR","Role must be OWNER or STAFF.");if(String(id)===req.admin.id&&!isActive)throw new AppError(409,"SELF_DISABLE_FORBIDDEN","You cannot disable your own account.");if(current.rows[0].role==="OWNER"&&(role!=="OWNER"||!isActive)){const count=await database.query("SELECT COUNT(*)::integer AS count FROM admin_users WHERE role='OWNER' AND is_active");if(count.rows[0].count<=1)throw new AppError(409,"LAST_OWNER_REQUIRED","At least one active OWNER is required.");}
    const result=await database.query("UPDATE admin_users SET role=$2,is_active=$3 WHERE id=$1 RETURNING id,email,display_name,role,is_active,created_at",[id,role,isActive]);if(!isActive)await database.query("DELETE FROM admin_sessions WHERE admin_user_id=$1",[id]);await audit(database,req,"ADMIN_USER_UPDATED","admin_user",String(id),{role,isActive});res.json({user:{...result.rows[0],id:String(result.rows[0].id)}});
  }));

  return router;
}

module.exports = { buildAdminRouter, menuInput, categoryInput, specialInput };
