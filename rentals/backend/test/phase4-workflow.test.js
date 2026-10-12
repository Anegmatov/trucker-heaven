const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const adminPolicy = require("../../frontend-admin/workflow-policy");
const rentalsCore = require("../../frontend-customer/rentals-core");

test("admin workflow permissions default safely and expose only valid reservation actions", () => {
  assert.equal(adminPolicy.canMutate("OWNER"), true);
  assert.equal(adminPolicy.canMutate("manager"), false);
  assert.equal(adminPolicy.canMutate("STAFF"), true);
  assert.equal(adminPolicy.canConfigure("OWNER"), true);
  assert.equal(adminPolicy.canConfigure("STAFF"), false);
  assert.equal(adminPolicy.canMutate("UNKNOWN"), false);
  assert.deepEqual(adminPolicy.reservationActions("PENDING_REQUEST", "OWNER"), ["CONFIRMED", "DECLINED", "CANCELLED"]);
  assert.deepEqual(adminPolicy.reservationActions("CONFIRMED", "STAFF"), ["READY_FOR_PICKUP", "CANCELLED", "NO_SHOW"]);
  assert.deepEqual(adminPolicy.reservationActions("READY_FOR_PICKUP", "OWNER"), ["CHECKED_OUT", "CANCELLED", "NO_SHOW"]);
  assert.deepEqual(adminPolicy.reservationActions("CHECKED_OUT", "OWNER"), ["RETURNED_PENDING_INSPECTION"]);
  assert.deepEqual(adminPolicy.reservationActions("RETURNED_PENDING_INSPECTION", "OWNER"), ["COMPLETED"]);
  assert.deepEqual(adminPolicy.reservationActions("COMPLETED", "OWNER"), []);
});

test("admin access badges and mutation controls follow the centralized role policy", () => {
  assert.deepEqual(adminPolicy.accessBadge("OWNER"), { label: "Owner access", readOnly: false });
  assert.deepEqual(adminPolicy.accessBadge("manager"), { label: "Read-only access", readOnly: true });
  assert.deepEqual(adminPolicy.accessBadge("STAFF"), { label: "Operations access", readOnly: false });
  assert.deepEqual(adminPolicy.accessBadge(""), { label: "Read-only access", readOnly: true });
  assert.deepEqual(adminPolicy.reservationActions("PENDING_REQUEST", "STAFF"), ["CONFIRMED", "DECLINED", "CANCELLED"]);
  assert.deepEqual(adminPolicy.reservationActions("PENDING_REQUEST", "UNKNOWN"), []);
});

test("admin HTTP failure policy distinguishes authentication, permission, and stale state", () => {
  assert.deepEqual(adminPolicy.failureBehavior(401), { clearSession: true, refresh: false, kind: "authentication" });
  assert.deepEqual(adminPolicy.failureBehavior(403), { clearSession: false, refresh: false, kind: "permission" });
  assert.deepEqual(adminPolicy.failureBehavior(409), { clearSession: false, refresh: true, kind: "conflict" });
  assert.deepEqual(adminPolicy.failureBehavior(404), { clearSession: false, refresh: true, kind: "missing" });
  assert.deepEqual(adminPolicy.failureBehavior(503), { clearSession: false, refresh: false, kind: "temporary" });
});

test("customer server errors map to accessible fields without exposing internal text", () => {
  assert.equal(rentalsCore.fieldForError({ code: "INVALID_CUSTOMER_NAME" }), "customerName");
  assert.equal(rentalsCore.fieldForError({ code: "INVALID_EMAIL" }), "customerEmail");
  assert.equal(rentalsCore.fieldForError({ code: "INVALID_PHONE" }), "customerPhone");
  assert.equal(rentalsCore.fieldForError({ code: "PICKUP_IN_PAST" }), "pickupTime");
  assert.equal(rentalsCore.fieldForError({ status: 409 }), null);
});

test("frontend mutation and accessible-success wiring remains present", () => {
  const root = path.join(__dirname, "..", "..");
  const adminSource = fs.readFileSync(path.join(root, "frontend-admin", "app.js"), "utf8");
  const adminHtml = fs.readFileSync(path.join(root, "frontend-admin", "index.html"), "utf8");
  const adminStyles = fs.readFileSync(path.join(root, "frontend-admin", "styles.css"), "utf8");
  const customerSource = fs.readFileSync(path.join(root, "frontend-customer", "app.js"), "utf8");
  assert.match(adminSource, /pendingMutations\.has/);
  assert.match(adminSource, /The latest data has been loaded/);
  assert.match(adminSource, /showLogin\("Your session has expired/);
  assert.match(customerSource, /aria-invalid/);
  assert.match(customerSource, /first\?\.focus\(\)/);
  assert.match(customerSource, /reservationNumber/);
  assert.match(adminHtml, /id="adminShell" hidden/);
  assert.match(adminStyles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(adminSource, /state\.vehicles = \[\];\s*state\.reservations = \[\];/);
  assert.match(adminSource, /\$\("#adminShell"\)\.hidden = true;\s*\$\("#loginGate"\)\.hidden = false;/);
  assert.match(adminSource, /\$\("#loginGate"\)\.hidden = true;\s*\$\("#adminShell"\)\.hidden = false;/);
  assert.match(adminSource, /const badge = accessBadge\(role\);/);
  assert.match(adminSource, /\$\("#readOnlyBadge"\)\.textContent = badge\.label;/);
});
