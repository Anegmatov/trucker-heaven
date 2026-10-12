const crypto = require("node:crypto");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { AppError, asyncRoute } = require("../lib/http");
const validation = require("../lib/validation");
const { sha256 } = require("../lib/auth");
const { calculateTotals, publicOrderNumber } = require("../lib/orderPolicy");
const { INVENTORY_MODES, effectiveAvailability, insufficientAvailability, applyInventoryDeltas, restoreOrderInventory } = require("../lib/inventory");

function publicOrderSql() {
  return `
    SELECT o.public_order_number, o.customer_name, o.order_type, o.requested_at, o.status,
           o.subtotal_cents, o.tax_cents, o.total_cents, o.estimated_ready_at, o.payment_method, o.payment_status,
           o.customer_instructions, o.created_at
    FROM orders o
  `;
}

const publicMenuColumns = `i.id, i.category_id, c.slug AS category_slug, i.name, i.description, i.price_cents,
  i.primary_image_path, i.image_alt_text, i.is_available, i.is_featured,
  i.inventory_mode, i.available_quantity,
  i.dietary_information, i.dietary_information_verified,
  i.allergen_information, i.allergen_information_verified`;
const publicMenuWhere = "i.is_active = TRUE AND c.is_active = TRUE";

function asPublicMenuItem(row, modifierGroups = []) {
  return {
    id: String(row.id), categoryId: String(row.category_id), categorySlug: row.category_slug,
    name: row.name, description: row.description, priceCents: row.price_cents,
    imagePath: row.primary_image_path, imageAlt: row.image_alt_text,
    isAvailable: effectiveAvailability(row), isFeatured: row.is_featured,
    dietaryInformation: row.dietary_information_verified ? row.dietary_information : "",
    allergenInformation: row.allergen_information_verified ? row.allergen_information : "",
    hasVerifiedDietaryInformation: row.dietary_information_verified === true,
    hasVerifiedAllergenInformation: row.allergen_information_verified === true,
    modifierGroups
  };
}

async function publicModifierGroups(database, itemIds) {
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

function setDynamicCachePolicy(res) {
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("Pragma", "no-cache");
}

function businessStatus(hours, exceptions, timezone, now = new Date()) {
  let formatter;
  try {
    formatter = new globalThis.Intl.DateTimeFormat("en-US", {
      timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    });
  } catch {
    return { isOpen: null, todayHours: "Hours not yet published", reason: "INVALID_TIMEZONE" };
  }
  const parts = Object.fromEntries(formatter.formatToParts(now)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const dayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  const exception = exceptions.find((row) => String(row.exception_date).slice(0, 10) === date);
  const schedule = exception || hours.find((row) => row.day_of_week === dayIndex);
  if (!schedule) return { isOpen: null, todayHours: "Hours not yet published", date, timezone };
  if (schedule.is_closed) return { isOpen: false, todayHours: exception?.label || "Closed today", date, timezone, exception: Boolean(exception) };
  const toMinutes = (value) => { const [hour, minute] = String(value || "").split(":").map(Number); return hour * 60 + minute; };
  const opens = toMinutes(schedule.opens_at);
  const closes = toMinutes(schedule.closes_at);
  const isOpen = closes < opens ? minutes >= opens || minutes < closes : minutes >= opens && minutes < closes;
  return { isOpen, todayHours: `${String(schedule.opens_at).slice(0, 5)}–${String(schedule.closes_at).slice(0, 5)}`, date, timezone, exception: Boolean(exception) };
}

async function safeOrder(database, orderNumber, token) {
  if (!/^FO-\d{8}-[A-F0-9]{6}$/.test(orderNumber) || typeof token !== "string" || token.length < 32 || token.length > 256) {
    throw new AppError(404, "ORDER_NOT_FOUND", "Order number or access credential is invalid.");
  }
  const order = await database.query(`${publicOrderSql()} WHERE o.public_order_number = $1 AND (
    o.lookup_token_hash = $2 OR EXISTS (
      SELECT 1 FROM customer_order_access_sessions access
      WHERE access.order_id = o.id AND access.token_hash = $2 AND access.expires_at > NOW()
    )
  )`, [orderNumber, sha256(token)]);
  if (!order.rowCount) throw new AppError(404, "ORDER_NOT_FOUND", "Order number or access credential is invalid.");
  const [items, modifiers, history, notes, settings] = await Promise.all([
    database.query(`SELECT id,item_name_snapshot AS name, description_snapshot AS description,
      unit_price_cents,modifier_total_cents,quantity,line_total_cents,customer_item_notes AS notes
      FROM order_items WHERE order_id = (SELECT id FROM orders WHERE public_order_number = $1) ORDER BY id`, [orderNumber]),
    database.query(`SELECT oim.order_item_id,oim.group_name_snapshot,oim.option_name_snapshot,oim.price_delta_cents
      FROM order_item_modifiers oim JOIN order_items oi ON oi.id=oim.order_item_id
      WHERE oi.order_id=(SELECT id FROM orders WHERE public_order_number=$1)
      ORDER BY oim.order_item_id,oim.id`, [orderNumber]),
    database.query(`SELECT previous_status, new_status, created_at
      FROM order_status_history WHERE order_id = (SELECT id FROM orders WHERE public_order_number = $1) ORDER BY created_at, id`, [orderNumber]),
    database.query(`SELECT note_text, created_at FROM order_notes
      WHERE order_id = (SELECT id FROM orders WHERE public_order_number = $1) AND visibility = 'CUSTOMER' ORDER BY created_at, id`, [orderNumber]),
    database.query("SELECT phone, order_payment_instructions, pickup_instructions FROM site_settings WHERE id = 1")
  ]);
  const modifiersByItem = new Map();
  for (const modifier of modifiers.rows) {
    const key = String(modifier.order_item_id);
    if (!modifiersByItem.has(key)) modifiersByItem.set(key, []);
    modifiersByItem.get(key).push({ groupName: modifier.group_name_snapshot,
      optionName: modifier.option_name_snapshot, priceDeltaCents: modifier.price_delta_cents });
  }
  const row = order.rows[0];
  return {
    orderNumber: row.public_order_number,
    customerName: row.customer_name,
    orderType: row.order_type,
    requestedAt: row.requested_at,
    estimatedReadyAt: row.estimated_ready_at,
    status: row.status,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    customerInstructions: row.customer_instructions,
    createdAt: row.created_at,
    items: items.rows.map((item) => ({
      name: item.name, description: item.description, unitPriceCents: item.unit_price_cents,
      modifierTotalCents: item.modifier_total_cents, quantity: item.quantity,
      lineTotalCents: item.line_total_cents, notes: item.notes,
      modifiers: modifiersByItem.get(String(item.id)) || []
    })),
    history: history.rows.map((item) => ({ previousStatus: item.previous_status, status: item.new_status, createdAt: item.created_at })),
    notes: notes.rows.map((item) => ({ text: item.note_text, createdAt: item.created_at })),
    restaurantPhone: settings.rows[0]?.phone || "",
    paymentInstructions: settings.rows[0]?.order_payment_instructions || "Payment is collected at pickup or on site.",
    pickupInstructions: settings.rows[0]?.pickup_instructions || ""
  };
}

function buildPublicRouter(database, pushNotifications = { sendNewOrder: async () => ({ configured: false }) }) {
  const router = express.Router();
  const lookupFailure = "We couldn’t find a recent order with those details.";
  const lookupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 12,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler(req, res) {
      res.status(429).json({ error: { code: "ORDER_LOOKUP_RATE_LIMITED", message: lookupFailure } });
    }
  });

  router.post("/catering-requests", asyncRoute(async (req, res) => {
    const fullName = validation.text(req.body.fullName, "fullName", { max: 160 });
    const phone = validation.text(req.body.phone, "phone", { max: 50 });
    const email = validation.optionalEmail(req.body.email);
    if (!email) throw new AppError(422, "VALIDATION_ERROR", "email is required.", { field: "email" });
    const company = validation.text(req.body.company, "company", { required: false, max: 200 });
    const eventDate = validation.text(req.body.eventDate, "eventDate", { max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new AppError(422, "VALIDATION_ERROR", "eventDate must be a date.", { field: "eventDate" });
    const pickupTime = validation.text(req.body.pickupTime, "pickupTime", { max: 8 });
    if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(pickupTime)) throw new AppError(422, "VALIDATION_ERROR", "pickupTime must be a time.", { field: "pickupTime" });
    const guestCount = validation.integer(req.body.guestCount, "guestCount", { minimum: 1, maximum: 10000 });
    const orderType = validation.text(req.body.orderType, "orderType", { max: 20 }).toUpperCase();
    if (!new Set(["PICKUP", "DELIVERY"]).has(orderType)) throw new AppError(422, "VALIDATION_ERROR", "orderType must be PICKUP or DELIVERY.", { field: "orderType" });
    if (!Array.isArray(req.body.interestedIn) || req.body.interestedIn.length < 1 || req.body.interestedIn.length > 12) {
      throw new AppError(422, "VALIDATION_ERROR", "Choose at least one catering interest.", { field: "interestedIn" });
    }
    const interestedIn = [...new Set(req.body.interestedIn.map((entry) => validation.text(entry, "interestedIn", { max: 100 })))];
    const specialNotes = validation.text(req.body.specialNotes, "specialNotes", { required: false, max: 3000 });
    const preferredContactMethod = validation.text(req.body.preferredContactMethod, "preferredContactMethod", { max: 20 }).toUpperCase();
    if (!new Set(["PHONE", "EMAIL"]).has(preferredContactMethod)) throw new AppError(422, "VALIDATION_ERROR", "preferredContactMethod must be PHONE or EMAIL.", { field: "preferredContactMethod" });
    const requestNumber = `CAT-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const result = await database.query(`INSERT INTO catering_requests (
      public_request_number,full_name,phone,email,company,event_date,pickup_time,guest_count,
      order_type,interested_in,special_notes,preferred_contact_method
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12)
    RETURNING public_request_number,status,created_at`, [requestNumber, fullName, phone, email, company,
      eventDate, pickupTime, guestCount, orderType, interestedIn, specialNotes, preferredContactMethod]);
    const row = result.rows[0];
    res.status(201).json({ requestNumber: row.public_request_number, status: row.status, createdAt: row.created_at });
  }));

  router.get("/site", asyncRoute(async (req, res) => {
    const [settings, hours, exceptions, specials, features, gallery] = await Promise.all([
      database.query("SELECT * FROM site_settings WHERE id = 1"),
      database.query("SELECT day_of_week, day_label, opens_at, closes_at, is_closed FROM business_hours ORDER BY display_order"),
      database.query("SELECT exception_date, label, opens_at, closes_at, is_closed FROM business_exceptions WHERE exception_date >= CURRENT_DATE - 1 ORDER BY exception_date LIMIT 60"),
      database.query(`SELECT title, description, price_cents, day_label, image_path, image_alt_text, is_sold_out
        FROM daily_specials WHERE is_active = TRUE
        AND (active_from IS NULL OR active_from <= CURRENT_DATE)
        AND (active_until IS NULL OR active_until >= CURRENT_DATE)
        ORDER BY display_order, id`),
      database.query("SELECT title, description, icon_key FROM lounge_features WHERE is_active = TRUE ORDER BY display_order, id"),
      database.query("SELECT image_path, alt_text, caption, category FROM gallery_items WHERE is_active = TRUE ORDER BY display_order, id")
    ]);
    const site = settings.rows[0] || {};
    setDynamicCachePolicy(res);
    res.json({
      settings: {
        businessName: site.business_name, heroTitle: site.hero_title, heroSubtitle: site.hero_subtitle,
        address: site.address, phone: site.phone, email: site.email, mapUrl: site.map_url,
        parentSiteUrl: site.parent_site_url, dineInWording: site.dine_in_wording,
        takeoutWording: site.takeout_wording, truckParkingWording: site.truck_parking_wording,
        familyFriendlyWording: site.family_friendly_wording, paymentInstructions: site.order_payment_instructions,
        timezone: site.timezone || "America/Chicago", publicDescription: site.public_description,
        pickupInstructions: site.pickup_instructions, dineInEnabled: site.dine_in_enabled !== false,
        takeoutEnabled: site.takeout_enabled !== false, acceptingOrders: site.accepting_orders !== false
      },
      hours: hours.rows.map((row) => ({ day: row.day_label, opensAt: row.opens_at, closesAt: row.closes_at, isClosed: row.is_closed })),
      businessStatus: businessStatus(hours.rows, exceptions.rows, site.timezone || "America/Chicago"),
      exceptions: exceptions.rows.map((row) => ({ date: row.exception_date, label: row.label, opensAt: row.opens_at, closesAt: row.closes_at, isClosed: row.is_closed })),
      specials: specials.rows.map((row) => ({
        title: row.title, description: row.description, priceCents: row.price_cents,
        dayLabel: row.day_label, imagePath: row.image_path, imageAlt: row.image_alt_text, isSoldOut: row.is_sold_out
      })),
      features: features.rows.map((row) => ({ title: row.title, description: row.description, icon: row.icon_key })),
      gallery: gallery.rows.map((row) => ({ imagePath: row.image_path, imageAlt: row.alt_text, caption: row.caption, category: row.category }))
    });
  }));

  router.get("/place-photos", asyncRoute(async (req, res) => {
    setDynamicCachePolicy(res);
    const apiKey = req.app.locals.config?.googlePlacesApiKey;
    const placeId = req.app.locals.config?.googlePlaceId;
    if (!apiKey || !placeId) return res.json({ enabled: false, reason: "NOT_CONFIGURED", photos: [] });
    const details = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "displayName,googleMapsUri,photos" }
    });
    if (!details.ok) throw new AppError(502, "PLACES_UNAVAILABLE", "Official Google Places photography is temporarily unavailable.");
    const place = await details.json();
    const photos = [];
    for (const photo of (place.photos || []).slice(0, 6)) {
      const media = await fetch(`https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=1600&skipHttpRedirect=true`, { headers: { "X-Goog-Api-Key": apiKey } });
      if (!media.ok) continue;
      const body = await media.json();
      if (body.photoUri) photos.push({ photoUri: body.photoUri, widthPx: photo.widthPx, heightPx: photo.heightPx, authorAttributions: photo.authorAttributions || [] });
    }
    res.json({ enabled: true, placeName: place.displayName?.text || "Trucker Heaven", googleMapsUri: place.googleMapsUri || "", photos });
  }));

  router.get("/categories", asyncRoute(async (req, res) => {
    const result = await database.query("SELECT id, name, slug, description FROM menu_categories WHERE is_active = TRUE ORDER BY display_order, id");
    setDynamicCachePolicy(res);
    res.json({ categories: result.rows.map((row) => ({ id: String(row.id), name: row.name, slug: row.slug, description: row.description })) });
  }));

  router.get("/menu", asyncRoute(async (req, res) => {
    const rawSlug = req.query.category == null ? "" : String(req.query.category).trim();
    const slug = rawSlug ? validation.slug(rawSlug) : "";
    const params = [];
    const where = [publicMenuWhere];
    if (slug) { params.push(slug); where.push(`c.slug = $${params.length}`); }
    const search = validation.text(req.query.search, "search", { required: false, max: 120 });
    if (search) { params.push(`%${search}%`); where.push(`(i.name ILIKE $${params.length} OR i.description ILIKE $${params.length})`); }
    const setting = await database.query("SELECT show_unavailable_items FROM site_settings WHERE id=1");
    if (!setting.rows[0]?.show_unavailable_items) {
      where.push("i.is_available=TRUE AND (i.inventory_mode <> 'QUANTITY_TRACKED' OR i.available_quantity > 0)");
    }
    const result = await database.query(`SELECT ${publicMenuColumns}
      FROM menu_items i JOIN menu_categories c ON c.id = i.category_id
      WHERE ${where.join(" AND ")} ORDER BY i.display_order, i.id`, params);
    const modifiers = await publicModifierGroups(database, result.rows.map((row) => row.id));
    setDynamicCachePolicy(res);
    res.json({ items: result.rows.map((row) => asPublicMenuItem(row, modifiers.get(String(row.id)) || [])) });
  }));

  router.get("/menu/:id", asyncRoute(async (req, res) => {
    const id = validation.integer(req.params.id, "id", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    const setting = await database.query("SELECT show_unavailable_items FROM site_settings WHERE id=1");
    const result = await database.query(`SELECT ${publicMenuColumns}
      FROM menu_items i JOIN menu_categories c ON c.id=i.category_id
      WHERE ${publicMenuWhere} AND i.id=$1 ${setting.rows[0]?.show_unavailable_items ? "" : "AND i.is_available=TRUE AND (i.inventory_mode <> 'QUANTITY_TRACKED' OR i.available_quantity > 0)"}`, [id]);
    if (!result.rowCount) throw new AppError(404, "MENU_ITEM_NOT_FOUND", "That menu item is not published.");
    const modifiers = await publicModifierGroups(database, [id]);
    setDynamicCachePolicy(res);
    res.json({ item: asPublicMenuItem(result.rows[0], modifiers.get(String(id)) || []) });
  }));

  router.post("/orders", asyncRoute(async (req, res) => {
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required.");
    }
    const rawItems = req.body?.items;
    if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 50) throw new AppError(422, "EMPTY_ORDER", "Add at least one item to the order.");
    if (rawItems.some((item) => "price" in item || "priceCents" in item || "lineTotal" in item || "total" in item)) {
      throw new AppError(422, "CLIENT_PRICE_REJECTED", "Order pricing is calculated by the restaurant.");
    }
    if (req.body.termsAccepted !== true || req.body.payOnSiteAccepted !== true) {
      throw new AppError(422, "ACKNOWLEDGEMENT_REQUIRED", "Accept the ordering terms and pay-on-site acknowledgement.");
    }
    const items = rawItems.map((item) => ({
      itemId: validation.integer(item.itemId, "itemId", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      quantity: validation.integer(item.quantity, "quantity", { minimum: 1, maximum: 99 }),
      notes: validation.text(item.notes, "item notes", { required: false, max: 300 }),
      modifierOptionIds: (() => {
        const raw = item.modifierOptionIds ?? [];
        if (!Array.isArray(raw) || raw.length > 100) throw new AppError(422, "INVALID_MODIFIER_SELECTION", "Modifier selections are invalid.");
        const ids = raw.map((id) => validation.integer(id, "modifierOptionId", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER }));
        if (new Set(ids).size !== ids.length) throw new AppError(422, "INVALID_MODIFIER_SELECTION", "Choose each modifier option only once.");
        return ids;
      })()
    }));
    const customerName = validation.text(req.body.customerName, "customerName", { max: 160 });
    const customerPhone = validation.text(req.body.customerPhone, "customerPhone", { max: 30 });
    const customerEmail = validation.optionalEmail(req.body.customerEmail);
    const orderType = req.body.orderType;
    if (!new Set(["DINE_IN", "TAKEOUT"]).has(orderType)) throw new AppError(422, "VALIDATION_ERROR", "Choose Dine In or Takeout.", { field: "orderType" });
    const customerInstructions = validation.text(req.body.customerInstructions, "customerInstructions", { required: false, max: 1000 });
    let requestedAt = null;
    if (req.body.requestedAt) {
      requestedAt = new Date(req.body.requestedAt);
      if (Number.isNaN(requestedAt.valueOf()) || requestedAt < new Date(Date.now() - 60000) || requestedAt > new Date(Date.now() + 14 * 86400000)) {
        throw new AppError(422, "VALIDATION_ERROR", "Requested time must be within the next 14 days.", { field: "requestedAt" });
      }
    }
    const canonicalRequest = JSON.stringify({ customerName, customerPhone, customerEmail, orderType, requestedAt, customerInstructions, items });
    const keyHash = sha256(idempotencyKey);
    const requestHash = sha256(canonicalRequest);
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [keyHash]);
      const prior = await client.query("SELECT request_hash, response_status, response_body FROM idempotency_records WHERE key_hash = $1 AND expires_at > NOW()", [keyHash]);
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== requestHash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different order.");
        await client.query("COMMIT");
        return res.status(prior.rows[0].response_status).json(prior.rows[0].response_body);
      }
      const menu = await client.query(`SELECT i.id, i.name, i.description, i.price_cents, i.primary_image_path,
        i.is_available, i.inventory_mode, i.available_quantity
        FROM menu_items i JOIN menu_categories c ON c.id = i.category_id
        WHERE i.id = ANY($1::bigint[]) AND i.is_active = TRUE AND c.is_active = TRUE
        ORDER BY i.id FOR UPDATE OF i`, [[...new Set(items.map((item) => item.itemId))]]);
      if (menu.rowCount !== new Set(items.map((item) => item.itemId)).size) throw new AppError(409, "ITEM_UNAVAILABLE", "One or more menu items are unavailable. Refresh the menu and try again.");
      const authoritative = new Map(menu.rows.map((row) => [String(row.id), row]));
      const requestedByItem = new Map();
      for (const item of items) requestedByItem.set(String(item.itemId), (requestedByItem.get(String(item.itemId)) || 0) + item.quantity);
      for (const menuItem of menu.rows) {
        const requestedQuantity = requestedByItem.get(String(menuItem.id));
        if (!menuItem.is_available) throw new AppError(409, "ITEM_UNAVAILABLE", `${menuItem.name} is currently sold out. Refresh the menu and try again.`);
        if (menuItem.inventory_mode === INVENTORY_MODES.QUANTITY_TRACKED && Number(menuItem.available_quantity) < requestedQuantity) {
          throw insufficientAvailability(menuItem, requestedQuantity);
        }
      }
      const modifierRows = await client.query(`SELECT g.id AS group_id,g.menu_item_id,g.name AS group_name,
        g.minimum_selections,g.maximum_selections,o.id AS option_id,o.name AS option_name,o.price_delta_cents
        FROM menu_modifier_groups g JOIN menu_modifier_options o ON o.modifier_group_id=g.id
        WHERE g.menu_item_id=ANY($1::bigint[]) AND g.is_active=TRUE AND o.is_active=TRUE
        ORDER BY g.display_order,g.id,o.display_order,o.id FOR SHARE OF g,o`, [[...new Set(items.map((item) => item.itemId))]]);
      const groupsByItem = new Map();
      const optionById = new Map();
      for (const row of modifierRows.rows) {
        const itemKey = String(row.menu_item_id);
        if (!groupsByItem.has(itemKey)) groupsByItem.set(itemKey, new Map());
        const itemGroups = groupsByItem.get(itemKey);
        const groupKey = String(row.group_id);
        if (!itemGroups.has(groupKey)) itemGroups.set(groupKey, { id: groupKey, name: row.group_name,
          minimumSelections: row.minimum_selections, maximumSelections: row.maximum_selections, optionIds: new Set() });
        itemGroups.get(groupKey).optionIds.add(String(row.option_id));
        optionById.set(String(row.option_id), { id: String(row.option_id), groupId: groupKey, itemId: itemKey,
          groupName: row.group_name, optionName: row.option_name, priceDeltaCents: row.price_delta_cents });
      }
      const snapshots = items.map((item) => {
        const menuItem = authoritative.get(String(item.itemId));
        const selected = item.modifierOptionIds.map((id) => optionById.get(String(id)));
        if (selected.some((option) => !option || option.itemId !== String(item.itemId))) throw new AppError(409, "INVALID_MODIFIER_SELECTION", `${menuItem.name}: one or more choices are unavailable. Refresh the menu and try again.`);
        for (const group of groupsByItem.get(String(item.itemId))?.values() || []) {
          const count = selected.filter((option) => option.groupId === group.id).length;
          if (count < group.minimumSelections || count > group.maximumSelections) {
            const instruction = group.minimumSelections === group.maximumSelections
              ? `choose ${group.minimumSelections}` : `choose ${group.minimumSelections} to ${group.maximumSelections}`;
            throw new AppError(422, "MODIFIER_SELECTION_REQUIRED", `${menuItem.name} — ${group.name}: ${instruction}.`);
          }
        }
        const modifierTotalCents = selected.reduce((sum, option) => sum + option.priceDeltaCents, 0);
        return { ...item, name: menuItem.name, description: menuItem.description,
          unitPriceCents: menuItem.price_cents, modifierTotalCents, modifiers: selected,
          imagePath: menuItem.primary_image_path,
          inventoryReservedQuantity: menuItem.inventory_mode === INVENTORY_MODES.QUANTITY_TRACKED ? item.quantity : 0 };
      });
      const settings = await client.query("SELECT order_tax_basis_points, accepting_orders, dine_in_enabled, takeout_enabled, order_payment_instructions, pickup_instructions FROM site_settings WHERE id = 1 FOR SHARE");
      if (!settings.rowCount || !settings.rows[0].accepting_orders) throw new AppError(409, "ORDERING_PAUSED", "Online order requests are currently paused.");
      if (orderType === "DINE_IN" && !settings.rows[0].dine_in_enabled) throw new AppError(409, "ORDER_MODE_UNAVAILABLE", "Dine-in ordering is currently unavailable.");
      if (orderType === "TAKEOUT" && !settings.rows[0].takeout_enabled) throw new AppError(409, "ORDER_MODE_UNAVAILABLE", "Takeout ordering is currently unavailable.");
      await applyInventoryDeltas(client, [...requestedByItem.entries()].flatMap(([menuItemId, quantity]) => {
        const item = authoritative.get(menuItemId);
        return item.inventory_mode === INVENTORY_MODES.QUANTITY_TRACKED ? [{ menuItemId, delta: quantity }] : [];
      }));
      const totals = calculateTotals(snapshots, settings.rows[0]?.order_tax_basis_points || 0);
      const orderNumber = publicOrderNumber();
      const accessToken = crypto.randomBytes(32).toString("base64url");
      const estimatedReadyAt = requestedAt || new Date(Date.now() + 20 * 60 * 1000);
      const ticket = await client.query(`INSERT INTO order_daily_ticket_counters (ticket_date,next_ticket_number)
        VALUES ((NOW() AT TIME ZONE 'America/Chicago')::date,2)
        ON CONFLICT (ticket_date) DO UPDATE SET next_ticket_number=order_daily_ticket_counters.next_ticket_number+1
        RETURNING ticket_date,next_ticket_number-1 AS ticket_number`);
      const order = await client.query(`INSERT INTO orders (
        public_order_number, lookup_token_hash, customer_name, customer_phone, customer_email,
        order_type, requested_at, estimated_ready_at, daily_ticket_date, daily_ticket_number, subtotal_cents, tax_cents, total_cents, customer_instructions
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, created_at`, [
        orderNumber, sha256(accessToken), customerName, customerPhone, customerEmail, orderType,
        requestedAt, estimatedReadyAt, ticket.rows[0].ticket_date, ticket.rows[0].ticket_number, totals.subtotalCents, totals.taxCents, totals.totalCents, customerInstructions
      ]);
      for (const item of snapshots) {
        const orderItem = await client.query(`INSERT INTO order_items (order_id, menu_item_id, item_name_snapshot, description_snapshot,
          unit_price_cents,modifier_total_cents,quantity,line_total_cents,customer_item_notes,inventory_reserved_quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [
          order.rows[0].id, item.itemId, item.name, item.description, item.unitPriceCents,
          item.modifierTotalCents,item.quantity,(item.unitPriceCents + item.modifierTotalCents) * item.quantity,item.notes,item.inventoryReservedQuantity
        ]);
        for (const modifier of item.modifiers) {
          await client.query(`INSERT INTO order_item_modifiers (order_item_id,modifier_group_id,modifier_option_id,
            group_name_snapshot,option_name_snapshot,price_delta_cents) VALUES ($1,$2,$3,$4,$5,$6)`,
          [orderItem.rows[0].id,modifier.groupId,modifier.id,modifier.groupName,modifier.optionName,modifier.priceDeltaCents]);
        }
      }
      await client.query(`INSERT INTO order_status_history (order_id, previous_status, new_status, actor_type)
        VALUES ($1, NULL, 'PENDING', 'CUSTOMER')`, [order.rows[0].id]);
      const response = {
        orderNumber, accessToken, customerName, orderType, requestedAt, estimatedReadyAt,
        status: "PENDING", ...totals, paymentMethod: "PAY_ON_SITE", paymentStatus: "DUE_ON_SITE",
        paymentInstructions: settings.rows[0].order_payment_instructions || "Payment is collected at pickup or on site.",
        pickupInstructions: settings.rows[0].pickup_instructions || "", createdAt: order.rows[0].created_at,
        items: snapshots.map((item) => ({ name: item.name, unitPriceCents: item.unitPriceCents,
          modifierTotalCents: item.modifierTotalCents, quantity: item.quantity,
          lineTotalCents: (item.unitPriceCents + item.modifierTotalCents) * item.quantity,
          notes: item.notes,
          modifiers: item.modifiers.map((modifier) => ({ groupName: modifier.groupName,
            optionName: modifier.optionName, priceDeltaCents: modifier.priceDeltaCents })) }))
      };
      await client.query(`INSERT INTO idempotency_records (key_hash, request_hash, response_status, response_body, expires_at)
        VALUES ($1,$2,201,$3::jsonb,NOW() + INTERVAL '24 hours')`, [keyHash, requestHash, JSON.stringify(response)]);
      await client.query("COMMIT");
      pushNotifications.sendNewOrder({
        orderNumber,
        ticketNumber: ticket.rows[0].ticket_number,
        itemCount: snapshots.reduce((sum, item) => sum + item.quantity, 0)
      }).catch((error) => console.error("[push] new-order delivery failed", error.message));
      res.status(201).json(response);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }));

  router.post("/orders/lookup", lookupLimiter, asyncRoute(async (req, res) => {
    const normalizedName = String(req.body?.fullName || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    const normalizedPhone = String(req.body?.phone || "").replace(/\D/g, "");
    if (normalizedName.length < 2 || normalizedName.length > 160 || normalizedPhone.length < 7 || normalizedPhone.length > 15) {
      throw new AppError(404, "ORDER_LOOKUP_NOT_FOUND", lookupFailure);
    }
    const matches = await database.query(`SELECT id, public_order_number, status, created_at, total_cents
      FROM orders
      WHERE LOWER(REGEXP_REPLACE(BTRIM(customer_name), '\\s+', ' ', 'g')) = $1
        AND REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g') = $2
        AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC, id DESC LIMIT 10`, [normalizedName, normalizedPhone]);
    if (!matches.rowCount) throw new AppError(404, "ORDER_LOOKUP_NOT_FOUND", lookupFailure);
    const orders = [];
    for (const row of matches.rows) {
      const accessToken = crypto.randomBytes(32).toString("base64url");
      await database.query(`INSERT INTO customer_order_access_sessions (order_id, token_hash, expires_at)
        VALUES ($1, $2, NOW() + INTERVAL '2 hours')`, [row.id, sha256(accessToken)]);
      orders.push({ orderNumber: row.public_order_number, accessToken, status: row.status,
        placedAt: row.created_at, totalCents: row.total_cents });
    }
    res.json({ orders });
  }));

  router.get("/orders/:orderNumber", asyncRoute(async (req, res) => {
    // Keep the credential out of URLs, browser history, proxies, and analytics.
    // The opaque credential is still verified by the same hashed-token lookup.
    res.json(await safeOrder(database, req.params.orderNumber, req.get("X-Order-Access-Credential")));
  }));

  router.post("/orders/:orderNumber/cancel", asyncRoute(async (req, res) => {
    const token = req.body?.accessToken;
    await safeOrder(database, req.params.orderNumber, token);
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const order = await client.query("SELECT id, status, inventory_restored_at FROM orders WHERE public_order_number = $1 AND lookup_token_hash = $2 FOR UPDATE", [req.params.orderNumber, sha256(token)]);
      if (!order.rowCount) throw new AppError(404, "ORDER_NOT_FOUND", "Order number or access credential is invalid.");
      if (order.rows[0].status !== "PENDING") throw new AppError(409, "ORDER_NOT_CANCELLABLE", "Only pending orders may be cancelled online.");
      const reason = validation.text(req.body.reason, "reason", { required: false, max: 300 }) || "Cancelled by customer";
      await restoreOrderInventory(client, order.rows[0]);
      await client.query("UPDATE orders SET status = 'CANCELLED' WHERE id = $1", [order.rows[0].id]);
      await client.query(`INSERT INTO order_status_history (order_id, previous_status, new_status, actor_type, reason)
        VALUES ($1, 'PENDING', 'CANCELLED', 'CUSTOMER', $2)`, [order.rows[0].id, reason]);
      await client.query("COMMIT");
      pushNotifications.sendStatusChanged({ orderNumber: req.params.orderNumber, status: "CANCELLED" }).catch(() => {});
      res.json(await safeOrder(database, req.params.orderNumber, token));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }));

  return router;
}

module.exports = { buildPublicRouter, safeOrder, businessStatus };
