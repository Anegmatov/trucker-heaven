const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");
const { runMigrations, migrationFiles } = require("../db/migrate");
const { loadConfig } = require("../lib/config");
const { createApp } = require("../server");

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("FoodOps PostgreSQL, HTTP, authorization, upload, and order lifecycle", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to an explicitly disposable foodops_test database" }, async (t) => {
  const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.slice(1));
  assert.match(databaseName, /foodops.*test|test.*foodops/i, "TEST_DATABASE_URL must name a disposable FoodOps test database");
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 10 });
  const uploads = path.join(__dirname, "..", "uploads", "menu-items");
  const beforeUploads = new Set(await fs.readdir(uploads));
  let server;
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");

    await t.test("migrations apply cleanly and are idempotent", async () => {
      assert.deepEqual(await migrationFiles(), ["001_foodops_foundation.sql", "002_order_history_integrity.sql", "003_foodops_operations.sql", "004_menu_customization.sql", "005_catering_requests.sql", "006_simplified_order_workflow.sql", "007_daily_order_tickets.sql", "008_order_adjustments.sql", "009_prepared_food_inventory.sql", "010_customer_order_lookup.sql", "011_admin_push_subscriptions.sql", "012_kitchen_devices.sql"]);
      await runMigrations(pool);
      await runMigrations(pool);
      const applied = await pool.query("SELECT migration FROM schema_migrations ORDER BY migration");
      assert.deepEqual(applied.rows.map((row) => row.migration), await migrationFiles());
      const required = ["admin_users","menu_categories","menu_items","menu_item_images","menu_modifier_groups","menu_modifier_options","daily_specials","business_hours","business_exceptions","gallery_items","lounge_features","site_settings","orders","order_items","order_item_modifiers","order_status_history","order_notes","idempotency_records","audit_events","catering_requests","customer_order_access_sessions"];
      const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])", [required]);
      assert.equal(tables.rowCount, required.length);
    });

    await t.test("development seed succeeds and remains repeatable", () => {
      const environment = { ...process.env, NODE_ENV: "development", DATABASE_URL: testDatabaseUrl, DATABASE_SSL: "false", COOKIE_SECURE: "false" };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const seeded = spawnSync(process.execPath, ["scripts/seedDevelopment.js"], { cwd: path.join(__dirname, ".."), env: environment, encoding: "utf8" });
        assert.equal(seeded.status, 0, seeded.stderr);
      }
    });

    const config = loadConfig({ ...process.env, NODE_ENV: "test", DATABASE_URL: testDatabaseUrl, DATABASE_SSL: "false", COOKIE_SECURE: "false", PORT: "3011", PUBLIC_ORIGINS: "http://localhost:5190", ADMIN_ORIGINS: "http://localhost:5191" });
    server = http.createServer(createApp({ database: pool, config }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function call(url, options = {}) {
      const response = await fetch(`${base}${url}`, options);
      const body = response.status === 204 ? null : await response.json().catch(() => null);
      return { response, body };
    }
    async function login(email, password) {
      const { response, body } = await call("/api/v1/admin/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:5191" }, body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 200, JSON.stringify(body));
      return { cookie: response.headers.get("set-cookie").split(";")[0], csrf: body.csrfToken, user: body.user };
    }
    async function admin(session, url, options = {}) {
      return call(`/api/v1/admin${url}`, { ...options, headers: { Origin: "http://localhost:5191", Cookie: session.cookie, ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": session.csrf } : {}), ...options.headers } });
    }
    function publicOrder(orderNumber, accessCredential) {
      return call(`/api/v1/public/orders/${orderNumber}`, { headers: { "X-Order-Access-Credential": accessCredential } });
    }

    await t.test("health, readiness, CORS, and stable errors are safe", async () => {
      assert.deepEqual((await call("/health")).body, { ok: true, service: "foodops-api" });
      assert.equal((await call("/readiness")).response.status, 200);
      const denied = await call("/api/v1/public/site", { headers: { Origin: "https://untrusted.example" } });
      assert.equal(denied.response.status, 403);
      assert.equal("stack" in denied.body.error, false);
      const credentialPreflight = await call("/api/v1/public/orders/FO-20260728-A1B2C3", { method: "OPTIONS", headers: { Origin: "http://localhost:5190", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "X-Order-Access-Credential" } });
      assert.equal(credentialPreflight.response.status, 204);
      assert.match(credentialPreflight.response.headers.get("access-control-allow-headers") || "", /X-Order-Access-Credential/i);
      const malformed = await call("/api/v1/public/orders", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "1234567890123456" }, body: "{" });
      assert.equal(malformed.body.error.code, "INVALID_JSON");
      const oversized = await call("/api/v1/public/orders", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "oversized-request-body-001" }, body: JSON.stringify({ padding: "x".repeat(300 * 1024) }) });
      assert.equal(oversized.response.status, 413);
      assert.equal("stack" in oversized.body.error, false);
    });

    const owner = await login("owner@truckerheaven.test", "ChangeMe-FoodOps-2026!");
    assert.equal(owner.user.role, "OWNER");
    let categoryId;
    let menuItemId;
    let modifierOptionId;
    let imagePath;

    await t.test("public catering submissions are stored and authenticated admins may operate them", async () => {
      const submitted = await call("/api/v1/public/catering-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5190" },
        body: JSON.stringify({ fullName: "Catering QA", phone: "615-555-0142", email: "catering@example.test",
          company: "Road Crew", eventDate: "2026-09-15", pickupTime: "11:30", guestCount: 24,
          orderType: "PICKUP", interestedIn: ["Plov trays", "Assorted samsa"], specialNotes: "Label the vegetarian tray.",
          preferredContactMethod: "PHONE" })
      });
      assert.equal(submitted.response.status, 201, JSON.stringify(submitted.body));
      assert.match(submitted.body.requestNumber, /^CAT-\d{8}-[A-F0-9]{6}$/);
      assert.equal(submitted.body.status, "NEW");

      const csrfDenied = await call(`/api/v1/admin/catering-requests/${submitted.body.requestNumber}/status`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Cookie: owner.cookie, Origin: "http://localhost:5191" },
        body: JSON.stringify({ status: "CONTACTED" })
      });
      assert.equal(csrfDenied.body.error.code, "CSRF_INVALID");

      const listed = await admin(owner, "/catering-requests?status=NEW&search=Road%20Crew");
      assert.equal(listed.body.requests.length, 1);
      assert.equal(listed.body.requests[0].guestCount, 24);
      const contacted = await admin(owner, `/catering-requests/${submitted.body.requestNumber}/status`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "CONTACTED" })
      });
      assert.equal(contacted.body.request.status, "CONTACTED");
      const noted = await admin(owner, `/catering-requests/${submitted.body.requestNumber}/notes`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adminNotes: "Call after 2 PM." })
      });
      assert.equal(noted.body.request.adminNotes, "Call after 2 PM.");
      const detail = await admin(owner, `/catering-requests/${submitted.body.requestNumber}`);
      assert.equal(detail.body.request.fullName, "Catering QA");
      assert.deepEqual(detail.body.request.interestedIn, ["Plov trays", "Assorted samsa"]);
    });

    await t.test("daily special images may be added, replaced, and removed", async () => {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const createdForm = new FormData();
      Object.entries({ title: "QA Special", dayLabel: "Tuesday", priceCents: "1200", description: "Special image workflow", displayOrder: "1", isActive: "true", isSoldOut: "false", imageAlt: "QA special" }).forEach(([key, value]) => createdForm.set(key, value));
      createdForm.set("image", new Blob([png], { type: "image/png" }), "qa-special.png");
      const created = await admin(owner, "/specials", { method: "POST", body: createdForm });
      assert.equal(created.response.status, 201, JSON.stringify(created.body));
      const firstPath = created.body.special.image_path;
      assert.ok((await fs.stat(path.join(uploads, path.basename(firstPath)))).size > 0);

      const replacedForm = new FormData();
      replacedForm.set("image", new Blob([png], { type: "image/png" }), "qa-special-replacement.png");
      const replaced = await admin(owner, `/specials/${created.body.special.id}`, { method: "PATCH", body: replacedForm });
      assert.equal(replaced.response.status, 200, JSON.stringify(replaced.body));
      assert.notEqual(replaced.body.special.image_path, firstPath);
      await assert.rejects(fs.stat(path.join(uploads, path.basename(firstPath))), /ENOENT/);

      const removeForm = new FormData(); removeForm.set("removeImage", "true");
      const removed = await admin(owner, `/specials/${created.body.special.id}`, { method: "PATCH", body: removeForm });
      assert.equal(removed.body.special.image_path, null);
      await assert.rejects(fs.stat(path.join(uploads, path.basename(replaced.body.special.image_path))), /ENOENT/);
    });

    await t.test("OWNER creates a category and menu item with an approved image type", async () => {
      const csrfDenied = await call("/api/v1/admin/categories", { method: "POST", headers: { "Content-Type": "application/json", Cookie: owner.cookie, Origin: "http://localhost:5191" }, body: JSON.stringify({ name: "Road Test", slug: "road-test", description: "", displayOrder: 90, isActive: true }) });
      assert.equal(csrfDenied.body.error.code, "CSRF_INVALID");
      const category = await admin(owner, "/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Road Test", slug: "road-test", description: "Browser workflow category", displayOrder: 90, isActive: true }) });
      assert.equal(category.response.status, 201, JSON.stringify(category.body));
      categoryId = String(category.body.category.id);

      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const form = new FormData();
      Object.entries({ categoryId, name: "QA Skillet", description: "Eggs and potatoes for the verification workflow.", priceCents: "1375", imageAlt: "QA breakfast skillet", displayOrder: "5", isActive: "true", isAvailable: "true", isFeatured: "true",
        dietaryInformation: "Vegetarian when ordered without meat", dietaryInformationVerified: "true",
        allergenInformation: "Contains eggs", allergenInformationVerified: "true",
        modifierGroups: JSON.stringify([{ name: "Choose a side", minimumSelections: 1, maximumSelections: 1,
          options: [{ name: "Toast", priceDeltaCents: 0 }, { name: "Fruit", priceDeltaCents: 250 }] }]) }).forEach(([key, value]) => form.set(key, value));
      form.set("image", new Blob([png], { type: "image/png" }), "qa-skillet.png");
      const created = await admin(owner, "/menu-items", { method: "POST", body: form });
      assert.equal(created.response.status, 201, JSON.stringify(created.body));
      menuItemId = created.body.item.id;
      modifierOptionId = created.body.item.modifierGroups[0].options.find((option) => option.name === "Fruit").id;
      imagePath = created.body.item.imagePath;
      assert.match(imagePath, /^\/uploads\/menu-items\/[0-9a-f-]+\.png$/);
      assert.deepEqual(created.body.item.publicVisibility, { isVisible: true, reason: "VISIBLE" });
      assert.ok((await fs.stat(path.join(uploads, path.basename(imagePath)))).size > 0);
      const publicCategories = await call("/api/v1/public/categories");
      const publicMenu = await call("/api/v1/public/menu?category=road-test");
      assert.equal(publicCategories.response.headers.get("cache-control"), "no-store, max-age=0");
      assert.ok(publicCategories.body.categories.some((item) => item.id === categoryId));
      assert.equal(publicMenu.body.items.find((item) => item.id === menuItemId).priceCents, 1375);
      assert.equal(publicMenu.body.items.find((item) => item.id === menuItemId).categorySlug, "road-test");
      assert.equal(publicMenu.body.items.find((item) => item.id === menuItemId).allergenInformation, "Contains eggs");
      assert.equal(publicMenu.body.items.find((item) => item.id === menuItemId).modifierGroups[0].minimumSelections, 1);
      assert.equal((await call("/api/v1/public/menu?search=skillet")).body.items.length, 1);
      assert.equal((await call(`/api/v1/public/menu/${menuItemId}`)).body.item.name, "QA Skillet");
      assert.equal("created_at" in publicMenu.body.items[0], false);
    });

    await t.test("public menu applies category, active, and availability publication rules", async () => {
      const inactiveCategory = await pool.query("INSERT INTO menu_categories (name, slug, is_active) VALUES ('Closed Category', 'closed-category', FALSE) RETURNING id");
      await pool.query(`INSERT INTO menu_items (category_id, name, description, price_cents, is_active, is_available)
        VALUES ($1, 'Hidden Category Item', '', 500, TRUE, TRUE), ($2, 'Inactive Item', '', 500, FALSE, TRUE), ($2, 'Unavailable Item', '', 500, TRUE, FALSE)`, [inactiveCategory.rows[0].id, categoryId]);
      const allMenu = await call("/api/v1/public/menu");
      assert.ok(allMenu.body.items.some((item) => item.id === menuItemId));
      assert.equal(allMenu.body.items.some((item) => ["Hidden Category Item", "Inactive Item"].includes(item.name)), false);
      assert.equal(allMenu.body.items.find((item) => item.name === "Unavailable Item").isAvailable, false);
      const slugMenu = await call("/api/v1/public/menu?category=road-test");
      assert.ok(slugMenu.body.items.some((item) => item.id === menuItemId));
      const adminItems = await admin(owner, "/menu-items?pageSize=100");
      const hiddenCategory = adminItems.body.items.find((item) => item.name === "Hidden Category Item");
      const inactive = adminItems.body.items.find((item) => item.name === "Inactive Item");
      const unavailable = adminItems.body.items.find((item) => item.name === "Unavailable Item");
      assert.deepEqual(hiddenCategory.publicVisibility, { isVisible: false, reason: "CATEGORY_INACTIVE" });
      assert.deepEqual(inactive.publicVisibility, { isVisible: false, reason: "ITEM_INACTIVE" });
      assert.deepEqual(unavailable.publicVisibility, { isVisible: false, reason: "ITEM_UNAVAILABLE" });
      await pool.query("UPDATE site_settings SET show_unavailable_items=FALSE WHERE id=1");
      const availableOnly = await call("/api/v1/public/menu");
      assert.equal(availableOnly.body.items.some((item) => item.name === "Unavailable Item"), false);
      await pool.query("UPDATE site_settings SET show_unavailable_items=TRUE WHERE id=1");
    });

    await t.test("duplicate category slugs are rejected with an actionable safe message", async () => {
      const duplicate = await admin(owner, "/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Duplicate Road Test", slug: "road-test", description: "", displayOrder: 0, isActive: true }) });
      assert.equal(duplicate.response.status, 409);
      assert.equal(duplicate.body.error.code, "CATEGORY_SLUG_EXISTS");
      assert.match(duplicate.body.error.message, /already uses this slug/i);
    });

    await t.test("upload policy rejects SVG, mismatched bytes, and oversized images", async () => {
      async function rejected(blob, filename) {
        const form = new FormData();
        Object.entries({ categoryId, name: `Rejected ${filename}`, description: "", priceCents: "100", imageAlt: "Rejected", displayOrder: "0", isActive: "true", isAvailable: "true", isFeatured: "false" }).forEach(([key, value]) => form.set(key, value));
        form.set("image", blob, filename);
        return admin(owner, "/menu-items", { method: "POST", body: form });
      }
      const svg = await rejected(new Blob(["<svg></svg>"], { type: "image/svg+xml" }), "unsafe.svg");
      assert.equal(svg.body.error.code, "INVALID_IMAGE");
      const mismatch = await rejected(new Blob(["not png"], { type: "image/png" }), "mismatch.png");
      assert.equal(mismatch.body.error.code, "INVALID_IMAGE");
      const oversized = await rejected(new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: "image/png" }), "large.png");
      assert.equal(oversized.body.error.code, "IMAGE_TOO_LARGE");
    });

    let order;
    const orderRequest = {
      customerName: "QA Customer", customerPhone: "615-555-0101", customerEmail: "qa@example.test",
      orderType: "TAKEOUT", requestedAt: null, customerInstructions: "Counter pickup",
      termsAccepted: true, payOnSiteAccepted: true, items: [{ itemId: menuItemId, quantity: 2, notes: "Crispy potatoes", modifierOptionIds: [modifierOptionId] }]
    };
    const orderHeaders = { "Content-Type": "application/json", "Idempotency-Key": "foodops-integration-order-001", Origin: "http://localhost:5190" };

    await t.test("public orders reject empty, manipulated, and unavailable submissions", async () => {
      const empty = await call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": "foodops-integration-empty-01" }, body: JSON.stringify({ ...orderRequest, items: [] }) });
      assert.equal(empty.body.error.code, "EMPTY_ORDER");
      for (const [quantity, key] of [[0, "zero"], [-1, "negative"], [100, "extreme"]]) {
        const invalidQuantity = await call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": `foodops-integration-${key}-quantity` }, body: JSON.stringify({ ...orderRequest, items: [{ ...orderRequest.items[0], quantity }] }) });
        assert.equal(invalidQuantity.response.status, 422);
        assert.equal(invalidQuantity.body.error.code, "VALIDATION_ERROR");
      }
      const manipulated = await call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": "foodops-integration-price-01" }, body: JSON.stringify({ ...orderRequest, items: [{ ...orderRequest.items[0], priceCents: 1 }] }) });
      assert.equal(manipulated.body.error.code, "CLIENT_PRICE_REJECTED");
      const nonexistent = await call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": "foodops-integration-missing-item" }, body: JSON.stringify({ ...orderRequest, items: [{ itemId: Number.MAX_SAFE_INTEGER, quantity: 1, notes: "", modifierOptionIds: [] }] }) });
      assert.equal(nonexistent.body.error.code, "ITEM_UNAVAILABLE");
      const hiddenItem = (await pool.query("SELECT id FROM menu_items WHERE name = 'Hidden Category Item'")).rows[0];
      const hidden = await call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": "foodops-integration-hidden-category-item" }, body: JSON.stringify({ ...orderRequest, items: [{ itemId: Number(hiddenItem.id), quantity: 1, notes: "", modifierOptionIds: [] }] }) });
      assert.equal(hidden.body.error.code, "ITEM_UNAVAILABLE");
      const missingModifier = await call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": "foodops-integration-modifier-01" }, body: JSON.stringify({ ...orderRequest, items: [{ ...orderRequest.items[0], modifierOptionIds: [] }] }) });
      assert.equal(missingModifier.body.error.code, "MODIFIER_SELECTION_REQUIRED");
      const unavailableForm = new FormData(); unavailableForm.set("isAvailable", "false");
      assert.equal((await admin(owner, `/menu-items/${menuItemId}`, { method: "PATCH", body: unavailableForm })).response.status, 200);
      const noLongerPublic = await call("/api/v1/public/menu?category=road-test");
      assert.equal(noLongerPublic.body.items.find((item) => item.id === menuItemId).isAvailable, false);
      const unavailable = await call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": "foodops-integration-unavailable-01" }, body: JSON.stringify(orderRequest) });
      assert.equal(unavailable.body.error.code, "ITEM_UNAVAILABLE");
      const restoreForm = new FormData(); restoreForm.set("isAvailable", "true");
      await admin(owner, `/menu-items/${menuItemId}`, { method: "PATCH", body: restoreForm });
    });

    await t.test("order creation recalculates totals, is idempotent, and preserves snapshots", async () => {
      const created = await call("/api/v1/public/orders", { method: "POST", headers: orderHeaders, body: JSON.stringify(orderRequest) });
      assert.equal(created.response.status, 201, JSON.stringify(created.body));
      order = created.body;
      assert.equal(order.subtotalCents, 3250);
      assert.equal(order.items[0].modifiers[0].optionName, "Fruit");
      assert.equal(order.paymentMethod, "PAY_ON_SITE");
      assert.equal(order.paymentStatus, "DUE_ON_SITE");
      const ticket = await pool.query("SELECT daily_ticket_date,daily_ticket_number FROM orders WHERE public_order_number=$1", [order.orderNumber]);
      assert.equal(ticket.rows[0].daily_ticket_number, 1);
      assert.ok(ticket.rows[0].daily_ticket_date);
      const duplicate = await call("/api/v1/public/orders", { method: "POST", headers: orderHeaders, body: JSON.stringify(orderRequest) });
      assert.deepEqual(duplicate.body, order);
      const conflict = await call("/api/v1/public/orders", { method: "POST", headers: orderHeaders, body: JSON.stringify({ ...orderRequest, customerName: "Different" }) });
      assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
      const concurrentKey = "foodops-concurrent-idempotency-001";
      const concurrentRequest = { ...orderRequest, customerName: "Idempotency Customer", customerPhone: "615-555-0170" };
      const concurrentDuplicate = await Promise.all([
        call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": concurrentKey }, body: JSON.stringify(concurrentRequest) }),
        call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": concurrentKey }, body: JSON.stringify(concurrentRequest) })
      ]);
      assert.deepEqual(concurrentDuplicate.map((result) => result.response.status), [201, 201]);
      assert.equal(concurrentDuplicate[0].body.orderNumber, concurrentDuplicate[1].body.orderNumber);
      const priceForm = new FormData(); priceForm.set("priceCents", "1475"); priceForm.set("name", "QA Skillet Updated");
      await admin(owner, `/menu-items/${menuItemId}`, { method: "PATCH", body: priceForm });
      const snapshot = await pool.query("SELECT item_name_snapshot,unit_price_cents,modifier_total_cents,line_total_cents FROM order_items WHERE order_id=(SELECT id FROM orders WHERE public_order_number=$1)", [order.orderNumber]);
      assert.deepEqual(snapshot.rows[0], { item_name_snapshot: "QA Skillet", unit_price_cents: 1375, modifier_total_cents: 250, line_total_cents: 3250 });
      const modifierSnapshot = await pool.query("SELECT group_name_snapshot,option_name_snapshot,price_delta_cents FROM order_item_modifiers WHERE order_item_id=(SELECT id FROM order_items WHERE order_id=(SELECT id FROM orders WHERE public_order_number=$1))", [order.orderNumber]);
      assert.deepEqual(modifierSnapshot.rows[0], { group_name_snapshot: "Choose a side", option_name_snapshot: "Fruit", price_delta_cents: 250 });
    });

    await t.test("secure lookup rejects invalid credentials and separates internal notes", async () => {
      const invalid = await publicOrder(order.orderNumber, "wrong");
      assert.equal(invalid.response.status, 404);
      const urlCredential = await call(`/api/v1/public/orders/${order.orderNumber}?accessToken=${encodeURIComponent(order.accessToken)}`);
      assert.equal(urlCredential.response.status, 404, "credentials are not accepted in URLs");
      const found = await publicOrder(order.orderNumber, order.accessToken);
      assert.equal(found.body.orderNumber, order.orderNumber);
      assert.equal("lookup_token_hash" in found.body, false);
      await admin(owner, `/orders/${order.orderNumber}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visibility: "INTERNAL", note: "Kitchen-only note" }) });
      await admin(owner, `/orders/${order.orderNumber}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visibility: "CUSTOMER", note: "Pickup at the front counter" }) });
      const noted = await publicOrder(order.orderNumber, order.accessToken);
      assert.equal(noted.body.notes.length, 1);
      assert.equal(noted.body.notes[0].text, "Pickup at the front counter");
      assert.doesNotMatch(JSON.stringify(noted.body), /Kitchen-only/);
      const second = await call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": "foodops-integration-order-002" }, body: JSON.stringify({ ...orderRequest, customerName: "Second QA Customer" }) });
      assert.equal(second.response.status, 201);
      assert.equal((await publicOrder(second.body.orderNumber, order.accessToken)).response.status, 404, "Order A credential cannot retrieve Order B");
      assert.equal((await publicOrder(order.orderNumber, second.body.accessToken)).response.status, 404, "Order B credential cannot retrieve Order A");
    });

    await t.test("name and phone lookup returns multiple recent orders with scoped access", async () => {
      const second = await call("/api/v1/public/orders", { method: "POST", headers: { ...orderHeaders, "Idempotency-Key": "foodops-customer-lookup-order-01" }, body: JSON.stringify({ ...orderRequest, customerName: "  qa   CUSTOMER ", customerPhone: "(615) 555-0101" }) });
      assert.equal(second.response.status, 201, JSON.stringify(second.body));
      const lookup = await call("/api/v1/public/orders/lookup", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:5190" }, body: JSON.stringify({ fullName: "QA Customer", phone: "6155550101" }) });
      assert.equal(lookup.response.status, 200, JSON.stringify(lookup.body));
      assert.equal(lookup.body.orders.length, 2);
      assert.equal("customerName" in lookup.body.orders[0], false);
      const selected = lookup.body.orders.find((entry) => entry.orderNumber === second.body.orderNumber);
      assert.ok(selected?.accessToken);
      const found = await publicOrder(selected.orderNumber, selected.accessToken);
      assert.equal(found.response.status, 200);
      assert.equal(found.body.customerName.trim().toLowerCase().replace(/\s+/g, " "), "qa customer");
      const wrong = await call("/api/v1/public/orders/lookup", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:5190" }, body: JSON.stringify({ fullName: "QA Customer", phone: "6155559999" }) });
      assert.equal(wrong.response.status, 404);
      assert.equal(wrong.body.error.message, "We couldn’t find a recent order with those details.");
      assert.doesNotMatch(JSON.stringify(wrong.body), /customer|phone|order number/i);
    });

    await t.test("admin operates the complete status and on-site payment lifecycle", async () => {
      const revisedReady = new Date(Date.now() + 45 * 60 * 1000).toISOString();
      const timing = await admin(owner, `/orders/${order.orderNumber}/timing`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estimatedReadyAt: revisedReady }) });
      assert.equal(timing.body.orderNumber, order.orderNumber);
      assert.ok(timing.body.estimatedReadyAt);
      const invalid = await admin(owner, `/orders/${order.orderNumber}/transition`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "READY" }) });
      assert.equal(invalid.body.error.code, "INVALID_STATUS_TRANSITION");
      for (const nextStatus of ["CONFIRMED", "READY"]) {
        const moved = await admin(owner, `/orders/${order.orderNumber}/transition`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: nextStatus }) });
        assert.equal(moved.body.status, nextStatus);
        const lookup = await publicOrder(order.orderNumber, order.accessToken);
        assert.equal(lookup.body.status, nextStatus);
      }
      const paid = await admin(owner, `/orders/${order.orderNumber}/payment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentStatus: "PAID_ON_SITE" }) });
      assert.equal(paid.body.paymentStatus, "PAID_ON_SITE");
      const complete = await admin(owner, `/orders/${order.orderNumber}/transition`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "COMPLETED" }) });
      assert.equal(complete.body.status, "COMPLETED");
      const detail = await admin(owner, `/orders/${order.orderNumber}`);
      assert.deepEqual(detail.body.order.history.map((item) => item.new_status), ["PENDING", "CONFIRMED", "READY", "COMPLETED"]);
      await assert.rejects(pool.query("UPDATE orders SET status='PENDING' WHERE public_order_number=$1", [order.orderNumber]), /invalid order status transition/);
      await assert.rejects(pool.query("DELETE FROM order_status_history WHERE order_id=(SELECT id FROM orders WHERE public_order_number=$1)", [order.orderNumber]), /append-only/);
    });

    await t.test("customer may cancel only an eligible pending order", async () => {
      const headers = { ...orderHeaders, "Idempotency-Key": "foodops-integration-cancel-001" };
      const created = await call("/api/v1/public/orders", { method: "POST", headers, body: JSON.stringify(orderRequest) });
      const cancelled = await call(`/api/v1/public/orders/${created.body.orderNumber}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken: created.body.accessToken, reason: "Plans changed" }) });
      assert.equal(cancelled.body.status, "CANCELLED");
      const again = await call(`/api/v1/public/orders/${created.body.orderNumber}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken: created.body.accessToken }) });
      assert.equal(again.body.error.code, "ORDER_NOT_CANCELLABLE");
    });

    await t.test("quantity inventory is atomic, restorable, and reconciled by active-order adjustments", async () => {
      async function createTracked(name, quantity) {
        const form = new FormData();
        Object.entries({ categoryId, name, description: `${name} inventory test`, priceCents: "500", displayOrder: "95",
          isActive: "true", isAvailable: "true", isFeatured: "false", inventoryMode: "QUANTITY_TRACKED",
          availableQuantity: String(quantity), modifierGroups: "[]" }).forEach(([key, value]) => form.set(key, value));
        const created = await admin(owner, "/menu-items", { method: "POST", body: form });
        assert.equal(created.response.status, 201, JSON.stringify(created.body));
        assert.equal(created.body.item.inventoryMode, "QUANTITY_TRACKED");
        assert.equal(created.body.item.availableQuantity, quantity);
        return created.body.item.id;
      }
      async function setQuantity(id, quantity) {
        const updated = await admin(owner, `/menu-items/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ availableQuantity: quantity }) });
        assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
      }
      async function quantity(id) {
        return Number((await pool.query("SELECT available_quantity FROM menu_items WHERE id=$1", [id])).rows[0].available_quantity);
      }
      function inventoryOrder(id, requestedQuantity, name = "Inventory QA") {
        return { customerName: name, customerPhone: "615-555-0199", customerEmail: "inventory@example.test", orderType: "TAKEOUT",
          requestedAt: null, customerInstructions: "", termsAccepted: true, payOnSiteAccepted: true,
          items: [{ itemId: id, quantity: requestedQuantity, notes: "", modifierOptionIds: [] }] };
      }
      async function place(id, requestedQuantity, key, name) {
        return call("/api/v1/public/orders", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, Origin: "http://localhost:5190" }, body: JSON.stringify(inventoryOrder(id, requestedQuantity, name)) });
      }

      const trackedA = await createTracked("Tracked Samsa QA", 10);
      const trackedB = await createTracked("Tracked Baklava QA", 10);

      const reserved = await place(trackedA, 3, "inventory-reserve-success-001");
      assert.equal(reserved.response.status, 201, JSON.stringify(reserved.body));
      assert.equal(reserved.body.paymentMethod, "PAY_ON_SITE");
      assert.equal(await quantity(trackedA), 7);
      const cancelled = await Promise.all([
        call(`/api/v1/public/orders/${reserved.body.orderNumber}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken: reserved.body.accessToken }) }),
        call(`/api/v1/public/orders/${reserved.body.orderNumber}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken: reserved.body.accessToken }) })
      ]);
      assert.deepEqual(cancelled.map((result) => result.response.status).sort(), [200, 409]);
      assert.equal(await quantity(trackedA), 10);
      await call(`/api/v1/public/orders/${reserved.body.orderNumber}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken: reserved.body.accessToken }) });
      assert.equal(await quantity(trackedA), 10, "cancellation restoration is idempotent");

      await setQuantity(trackedA, 2);
      const insufficient = await place(trackedA, 3, "inventory-insufficient-001");
      assert.equal(insufficient.response.status, 409);
      assert.equal(insufficient.body.error.code, "INSUFFICIENT_AVAILABILITY");
      assert.deepEqual(insufficient.body.error.details, { item: { id: trackedA, name: "Tracked Samsa QA" }, requestedQuantity: 3, availableQuantity: 2 });
      assert.equal(await quantity(trackedA), 2);

      await setQuantity(trackedA, 1);
      const concurrent = await Promise.all([
        place(trackedA, 1, "inventory-concurrent-customer-01", "Concurrent One"),
        place(trackedA, 1, "inventory-concurrent-customer-02", "Concurrent Two"),
      ]);
      assert.deepEqual(concurrent.map((result) => result.response.status).sort(), [201, 409]);
      assert.equal(await quantity(trackedA), 0);
      const soldOutMenu = await call("/api/v1/public/menu");
      assert.equal(soldOutMenu.body.items.find((item) => item.id === trackedA).isAvailable, false);
      const winner = concurrent.find((result) => result.response.status === 201).body;
      await call(`/api/v1/public/orders/${winner.orderNumber}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken: winner.accessToken }) });
      assert.equal(await quantity(trackedA), 1);

      await setQuantity(trackedA, 1);
      const completed = await place(trackedA, 1, "inventory-completed-order-01");
      for (const status of ["CONFIRMED", "READY", "COMPLETED"]) {
        const moved = await admin(owner, `/orders/${completed.body.orderNumber}/transition`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
        assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
      }
      assert.equal(await quantity(trackedA), 0, "completed inventory remains consumed");

      await setQuantity(trackedA, 5);
      await setQuantity(trackedB, 5);
      const adjusted = await place(trackedA, 1, "inventory-admin-adjustment-01");
      assert.equal(await quantity(trackedA), 4);
      const added = await admin(owner, `/orders/${adjusted.body.orderNumber}/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ menuItemId: trackedB, quantity: 2, notes: "" }) });
      assert.equal(added.response.status, 201, JSON.stringify(added.body));
      assert.equal(await quantity(trackedB), 3);
      await admin(owner, `/orders/${adjusted.body.orderNumber}/items/${added.body.lineKey}`, { method: "DELETE" });
      assert.equal(await quantity(trackedB), 5);
      const baseLine = (await pool.query("SELECT id FROM order_items WHERE order_id=(SELECT id FROM orders WHERE public_order_number=$1)", [adjusted.body.orderNumber])).rows[0];
      const lineKey = `base-${baseLine.id}`;
      const increased = await admin(owner, `/orders/${adjusted.body.orderNumber}/items/${lineKey}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quantity: 2 }) });
      assert.equal(increased.response.status, 200, JSON.stringify(increased.body));
      assert.equal(await quantity(trackedA), 3);
      const replaced = await admin(owner, `/orders/${adjusted.body.orderNumber}/items/${lineKey}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ replacementMenuItemId: trackedB, quantity: 2 }) });
      assert.equal(replaced.response.status, 200, JSON.stringify(replaced.body));
      assert.equal(await quantity(trackedA), 5);
      assert.equal(await quantity(trackedB), 3);
      const cancelledAdjustment = await admin(owner, `/orders/${adjusted.body.orderNumber}/transition`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "CANCELLED", reason: "Inventory QA" }) });
      assert.equal(cancelledAdjustment.response.status, 200);
      assert.equal(await quantity(trackedB), 5);

      const manual = (await admin(owner, `/menu-items/${menuItemId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inventoryMode: "MANUAL", isAvailable: true }) })).body.item;
      assert.equal(manual.inventoryMode, "MANUAL");
      assert.equal(manual.effectiveAvailable, true);
    });

    await t.test("archived unused items may be deleted while historical items are retained", async () => {
      const form = new FormData();
      Object.entries({ categoryId, name: "Disposable Menu QA", description: "Safe delete test", priceCents: "300", displayOrder: "99",
        isActive: "true", isAvailable: "true", isFeatured: "false", inventoryMode: "MANUAL", modifierGroups: "[]" }).forEach(([key, value]) => form.set(key, value));
      const created = await admin(owner, "/menu-items", { method: "POST", body: form });
      const disposableId = created.body.item.id;
      assert.equal((await admin(owner, `/menu-items/${disposableId}`, { method: "DELETE" })).response.status, 204);
      const archived = await admin(owner, "/menu-items?active=false&pageSize=100");
      assert.equal(archived.body.items.find((item) => item.id === disposableId).canPermanentlyDelete, true);
      assert.equal((await admin(owner, `/menu-items/${disposableId}/permanent`, { method: "DELETE" })).response.status, 204);
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM menu_items WHERE id=$1", [disposableId])).rows[0].count), 0);

      assert.equal((await admin(owner, `/menu-items/${menuItemId}`, { method: "DELETE" })).response.status, 204);
      const usedItems = await admin(owner, "/menu-items?active=false&pageSize=100");
      const used = usedItems.body.items.find((item) => item.id === menuItemId);
      assert.equal(used.canPermanentlyDelete, false);
      assert.match(used.permanentDeleteReason, /order history/i);
      const blocked = await admin(owner, `/menu-items/${menuItemId}/permanent`, { method: "DELETE" });
      assert.equal(blocked.response.status, 409);
      assert.equal(blocked.body.error.code, "MENU_ITEM_HISTORY_RETAINED");
      assert.equal((await publicOrder(order.orderNumber, order.accessToken)).response.status, 200);
    });

    await t.test("customer lookup is rate limited with a generic response", async () => {
      let limited;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const result = await call("/api/v1/public/orders/lookup", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:5190" }, body: JSON.stringify({ fullName: "No Such Guest", phone: "6155550000" }) });
        if (result.response.status === 429) { limited = result; break; }
      }
      assert.equal(limited?.response.status, 429);
      assert.equal(limited.body.error.message, "We couldn’t find a recent order with those details.");
    });

    await t.test("STAFF may operate content but cannot manage users", async () => {
      const staff = await login("staff@truckerheaven.test", "ChangeMe-Staff-2026!");
      assert.equal(staff.user.role, "STAFF");
      const restored = await admin(staff, "/auth/session");
      assert.equal(restored.body.user.email, "staff@truckerheaven.test");
      assert.equal((await admin(staff, "/menu-items?pageSize=5")).response.status, 200);
      const users = await admin(staff, "/users");
      assert.equal(users.response.status, 403);
      assert.equal(users.body.error.code, "OWNER_REQUIRED");
      const logout = await admin(staff, "/auth/logout", { method: "POST" });
      assert.equal(logout.response.status, 204);
      assert.equal((await admin(staff, "/dashboard")).response.status, 401);
    });

    await t.test("repeated invalid logins temporarily lock the account", async () => {
      for (let attempt = 0; attempt < config.loginMaxFailures; attempt += 1) {
        const denied = await call("/api/v1/admin/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:5191" }, body: JSON.stringify({ email: "owner@truckerheaven.test", password: "incorrect-password" }) });
        assert.equal(denied.body.error.code, "INVALID_CREDENTIALS");
      }
      const locked = await call("/api/v1/admin/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:5191" }, body: JSON.stringify({ email: "owner@truckerheaven.test", password: "ChangeMe-FoodOps-2026!" }) });
      assert.equal(locked.response.status, 423);
      assert.equal(locked.body.error.code, "ACCOUNT_LOCKED");
    });

    await t.test("audit events exist and no payment provider was called", async () => {
      const events = await pool.query("SELECT event_type FROM audit_events");
      assert.ok(events.rows.some((row) => row.event_type === "ORDER_STATUS_CHANGED"));
      assert.ok(events.rows.some((row) => row.event_type === "ORDER_PAYMENT_RECORDED"));
      const paymentMethod = await pool.query("SELECT DISTINCT payment_method FROM orders");
      assert.deepEqual(paymentMethod.rows, [{ payment_method: "PAY_ON_SITE" }]);
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    const afterUploads = await fs.readdir(uploads).catch(() => []);
    for (const file of afterUploads) if (!beforeUploads.has(file)) await fs.unlink(path.join(uploads, file)).catch(() => {});
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public").catch(() => {});
    await pool.end();
  }
});
