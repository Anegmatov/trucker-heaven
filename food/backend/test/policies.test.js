const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { canTransition, calculateTotals, publicOrderNumber } = require("../lib/orderPolicy");
const validation = require("../lib/validation");
const { loadConfig } = require("../lib/config");
const { signatureMatches, finalizeImage } = require("../lib/imageUpload");
const { requireOwner, sha256, cookies, sessionCookie } = require("../lib/auth");
const { createPushNotifications, newOrderMessage, newOrderAlarmMessage } = require("../lib/pushNotifications");

test("integer-cent totals and tax rounding are deterministic", () => {
  assert.deepEqual(calculateTotals([{ unitPriceCents: 1099, quantity: 2 }, { unitPriceCents: 250, quantity: 3 }], 925), { subtotalCents: 2948, taxCents: 273, totalCents: 3221 });
  assert.deepEqual(calculateTotals([{ unitPriceCents: 1000, modifierTotalCents: 250, quantity: 2 }], 1000), { subtotalCents: 2500, taxCents: 250, totalCents: 2750 });
});

test("the primary order lifecycle allows only forward transitions", () => {
  assert.equal(canTransition("PENDING", "CONFIRMED"), true);
  assert.equal(canTransition("CONFIRMED", "READY"), true);
  assert.equal(canTransition("CONFIRMED", "PREPARING"), false);
  assert.equal(canTransition("PREPARING", "READY"), true);
  assert.equal(canTransition("READY", "COMPLETED"), true);
  assert.equal(canTransition("READY", "PREPARING"), false);
  assert.equal(canTransition("COMPLETED", "PENDING"), false);
});

test("cancellation is limited to pending and confirmed orders", () => {
  assert.equal(canTransition("PENDING", "CANCELLED"), true);
  assert.equal(canTransition("CONFIRMED", "CANCELLED"), true);
  assert.equal(canTransition("PREPARING", "CANCELLED"), false);
});

test("public order numbers do not expose database IDs", () => {
  assert.equal(publicOrderNumber(new Date("2026-07-24T12:00:00Z"), "A1B2C3"), "FO-20260724-A1B2C3");
});

test("server validation rejects negative and floating-point cents", () => {
  assert.throws(() => validation.integer(-1, "priceCents"), /integer/);
  assert.throws(() => validation.integer(10.2, "priceCents"), /integer/);
  assert.equal(validation.integer("1250", "priceCents"), 1250);
});

test("category slugs reject traversal and unsafe punctuation", () => {
  assert.equal(validation.slug("Breakfast-Favorites"), "breakfast-favorites");
  assert.throws(() => validation.slug("../../etc/passwd"), /Slug/);
  assert.throws(() => validation.slug("burgers<script>"), /Slug/);
});

test("email and text validation return stable field errors", () => {
  assert.throws(() => validation.optionalEmail("not-an-email"), (error) => error.code === "VALIDATION_ERROR" && error.details.field === "email");
  assert.throws(() => validation.text("", "name"), (error) => error.code === "VALIDATION_ERROR");
});

test("configuration refuses ifta_db", () => {
  assert.throws(() => loadConfig({ DATABASE_URL: "postgresql://local/ifta_db", COOKIE_SECURE: "false" }), /never ifta_db/);
});

test("production configuration requires secure cookies", () => {
  const base = { NODE_ENV: "production", DATABASE_URL: "postgresql://local/foodops", DATABASE_SSL: "true",
    COOKIE_SECURE: "true", PUBLIC_ORIGINS: "https://food.example", ADMIN_ORIGINS: "https://admin.example",
    FOODOPS_UPLOAD_ROOT: "/persistent/foodops" };
  assert.throws(() => loadConfig({ ...base, COOKIE_SECURE: "false" }), /COOKIE_SECURE/);
  assert.throws(() => loadConfig({ ...base, DATABASE_SSL: "false" }), /DATABASE_SSL/);
  assert.throws(() => loadConfig({ ...base, PUBLIC_ORIGINS: "http://localhost:5173" }), /PUBLIC_ORIGINS/);
  assert.throws(() => loadConfig({ ...base, ADMIN_ORIGINS: "" }), /ADMIN_ORIGINS/);
  assert.throws(() => loadConfig({ ...base, FOODOPS_UPLOAD_ROOT: "" }), /FOODOPS_UPLOAD_ROOT/);
  assert.equal(loadConfig(base).cookieSecure, true);
  assert.deepEqual(loadConfig(base).capacitorOrigins, ["http://localhost"]);
  assert.throws(() => loadConfig({ ...base, CAPACITOR_ORIGINS: "http://untrusted.example" }), /CAPACITOR_ORIGINS/);
  assert.equal(loadConfig(base).firebaseServiceAccount, null);
  assert.throws(() => loadConfig({ ...base, FIREBASE_SERVICE_ACCOUNT_JSON: "not-json" }), /FIREBASE_SERVICE_ACCOUNT_JSON/);
});

test("push delivery remains explicitly disabled without Firebase credentials", async () => {
  const push = createPushNotifications({ query: async () => { throw new Error("database should not be queried"); } }, { firebaseServiceAccount: null });
  assert.equal(push.configured, false);
  assert.deepEqual(await push.sendNewOrder({ orderNumber: "FO-TEST", ticketNumber: 1, itemCount: 1 }), { configured: false, delivered: 0 });
});

test("new-order push includes a delegated Android notification and data payload", () => {
  const message = newOrderMessage({ locale: "en" }, { orderNumber: "FO-TEST", ticketNumber: 7, itemCount: 3 });
  assert.deepEqual(message.notification, {
    title: "SILK ROAD — NEW ORDER",
    body: "A new order has been received. Tap to open Kitchen."
  });
  assert.deepEqual(message.data, {
    eventType: "order.created",
    orderNumber: "FO-TEST",
    ticketNumber: "7",
    itemCount: "3",
    title: message.notification.title,
    body: message.notification.body
  });
  assert.equal(message.android.priority, "HIGH");
  assert.equal(message.android.notification.channelId, "foodops_order_alerts_v2");
  assert.equal(message.android.notification.proxy, "ALLOW");
});

test("new-order alarm companion is high-priority data-only delivery", () => {
  const message = newOrderAlarmMessage({ locale: "en" }, { orderNumber: "FO-TEST", ticketNumber: 7, itemCount: 3 });
  assert.equal(message.notification, undefined);
  assert.deepEqual(message.data, {
    eventType: "order.created",
    orderNumber: "FO-TEST",
    ticketNumber: "7",
    itemCount: "3",
    title: "SILK ROAD — NEW ORDER",
    body: "A new order has been received. Tap to open Kitchen."
  });
  assert.deepEqual(message.android, { priority: "HIGH" });
});

test("upload storage defaults locally and confines custom menu and temporary paths", () => {
  const defaults = loadConfig({ DATABASE_URL: "postgresql://local/foodops", COOKIE_SECURE: "false" });
  assert.match(defaults.uploadRoot, /backend[\\/]uploads$/);
  assert.equal(defaults.uploadDirectory, path.join(defaults.uploadRoot, "menu-items"));
  assert.equal(defaults.temporaryUploadDirectory, path.join(defaults.uploadRoot, "tmp"));
  const custom = loadConfig({ DATABASE_URL: "postgresql://local/foodops", COOKIE_SECURE: "false", FOODOPS_UPLOAD_ROOT: "/persistent/foodops" });
  assert.equal(custom.uploadRoot, path.resolve("/persistent/foodops"));
  for (const directory of [custom.uploadDirectory, custom.temporaryUploadDirectory]) assert.ok(path.relative(custom.uploadRoot, directory) && !path.relative(custom.uploadRoot, directory).startsWith(".."));
});

test("image signatures accept JPG, PNG, and WEBP only when bytes match", () => {
  assert.equal(signatureMatches(Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"), true);
  assert.equal(signatureMatches(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), "image/png"), true);
  assert.equal(signatureMatches(Buffer.from("RIFF0000WEBP"), "image/webp"), true);
  assert.equal(signatureMatches(Buffer.from("<svg></svg>"), "image/png"), false);
});

test("malicious upload names cannot escape the configured upload directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foodops-upload-policy-"));
  const temporaryUploadDirectory = path.join(root, "tmp");
  const uploadDirectory = path.join(root, "menu-items");
  await fs.mkdir(temporaryUploadDirectory);
  await fs.mkdir(uploadDirectory);
  const temporaryPath = path.join(temporaryUploadDirectory, "request.upload");
  await fs.writeFile(temporaryPath, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  try {
    const publicPath = await finalizeImage({ path: temporaryPath, originalname: "..\\..\\application.jpg", mimetype: "image/jpeg" }, { uploadDirectory });
    const filename = path.basename(publicPath);
    assert.match(filename, /^[0-9a-f-]{36}\.jpg$/);
    assert.ok((await fs.stat(path.join(uploadDirectory, filename))).isFile());
    assert.equal(await fs.stat(path.join(root, "application.jpg")).catch(() => null), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("session helpers hash credentials and parse cookies without exposing them", () => {
  assert.equal(sha256("private").length, 64);
  assert.deepEqual(cookies("first=one; foodops_session=secret%20token"), { first: "one", foodops_session: "secret token" });
  const cookie = sessionCookie("opaque", { sessionTtlHours: 12, cookieSameSite: "Lax", cookieSecure: true });
  assert.match(cookie, /Path=\/api\/v1\/admin/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  const crossSiteCookie = sessionCookie("opaque", { sessionTtlHours: 12, cookieSameSite: "None", cookieSecure: true });
  assert.match(crossSiteCookie, /SameSite=None/);
  assert.match(crossSiteCookie, /Partitioned/);
});

test("OWNER authorization denies STAFF at the backend middleware", () => {
  let error;
  requireOwner({ admin: { role: "STAFF" } }, {}, (value) => { error = value; });
  assert.equal(error.code, "OWNER_REQUIRED");
  let allowed = false;
  requireOwner({ admin: { role: "OWNER" } }, {}, () => { allowed = true; });
  assert.equal(allowed, true);
});
