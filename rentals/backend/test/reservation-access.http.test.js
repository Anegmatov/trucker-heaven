const assert = require("node:assert/strict");
const { createServer } = require("node:net");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");

const databaseUrl = (process.env.RENTALS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL);
function disposable(value) { try { return /(?:test|testing|disposable)/i.test(new URL(value).pathname); } catch { return false; } }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const result = server.address().port; await new Promise((resolve) => server.close(resolve)); return result; }
async function json(url, options = {}) { const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } }); const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers }; }
function cookie(response) { return String(response.headers.get("set-cookie") || "").split(";", 1)[0]; }

test("reservation access tokens use the real server, authentication, CSRF, and disposable PostgreSQL", async (t) => {
  if (!databaseUrl) return t.skip("TEST_DATABASE_URL is required");
  assert.equal(disposable(databaseUrl), true, "TEST_DATABASE_URL must be disposable");
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "driveops-access-"));
  const pool = new Pool({ connectionString: databaseUrl });
  const serverPort = await port();
  const environment = { ...process.env, RENTALS_DATABASE_URL: databaseUrl, PORT: String(serverPort), NODE_ENV: "test", RENTALS_CORS_ALLOWED_ORIGINS: "http://localhost:5174", RENTALS_COOKIE_SECURE: "false", RENTALS_SESSION_TOKEN_PEPPER: "packet-1b-test-pepper", RENTALS_RENTAL_UPLOAD_DIR: uploadDir, RENTALS_SMS_ENABLED: "false" };
  let child;
  t.after(async () => { child?.kill("SIGTERM"); await pool.end().catch(() => {}); await fs.rm(uploadDir, { recursive: true, force: true }); });
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
  await new Promise((resolve, reject) => { const migrate = spawn(process.execPath, ["migrations/run.js"], { cwd: path.join(__dirname, ".."), env: environment }); let output = ""; migrate.stderr.on("data", (value) => { output += value; }); migrate.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output))); });
  const password = "PacketOneAccessPassword9"; const hash = await bcrypt.hash(password, 12);
  const users = await pool.query("INSERT INTO admin_users (email,password_hash,role) VALUES ($1,$2,'OWNER'),($3,$2,'STAFF') RETURNING id,email,role", ["owner@packet.test", hash, "staff@packet.test"]);
  const vehicle = await pool.query("INSERT INTO vehicles (make,model,year,category,dailyrate,depositamount) VALUES ('Test','Access',2026,'Sedan',10,10) RETURNING vehicleid");
  const reservations = await pool.query("INSERT INTO reservationsmvp (vehicleid,customername,customeremail,pickupat,returnat,status,estimatedtotal,depositamount) VALUES ($1,'A Customer','a@packet.test',CURRENT_TIMESTAMP + INTERVAL '2 days',CURRENT_TIMESTAMP + INTERVAL '3 days','PENDING_REQUEST',10,10),($1,'B Customer','b@packet.test',CURRENT_TIMESTAMP + INTERVAL '4 days',CURRENT_TIMESTAMP + INTERVAL '5 days','PENDING_REQUEST',10,10) RETURNING reservationid", [vehicle.rows[0].vehicleid]);
  child = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: environment, stdio: "ignore" });
  const base = `http://127.0.0.1:${serverPort}`; for (let attempt = 0; attempt < 50; attempt += 1) { try { if ((await fetch(`${base}/api/health/live`)).ok) break; } catch {} await wait(100); if (attempt === 49) throw new Error("server did not start"); }
  async function login(email) { const result = await json(`${base}/api/admin/auth/login`, { method: "POST", body: JSON.stringify({ email, password }) }); assert.equal(result.status, 200); return { cookie: cookie(result), csrf: result.body.csrfToken }; }
  const owner = await login("owner@packet.test"); const staff = await login("staff@packet.test"); const issuePath = `/api/admin/reservations/${reservations.rows[0].reservationid}/access/issue`;
  async function createVehicle(credentials, overrides = {}) {
    const form = new FormData();
    const fields = {
      make: "Packet Ford", model: "Transit", year: "2026", plateNumber: "PACKET-NO-PHOTO", vin: "1M8GDM9AXKP042701",
      category: "Van", seats: "5", transmission: "Automatic", fuelType: "Gasoline", mileage: "0", dailyRate: "79",
      depositAmount: "250", status: "READY", locationName: "Trucker Heaven Rentals - Mt. Juliet", ...overrides
    };
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    const response = await fetch(`${base}/api/admin/vehicles`, {
      method: "POST", headers: { Cookie: credentials.cookie, "x-csrf-token": credentials.csrf }, body: form
    });
    return { status: response.status, body: await response.json() };
  }
  const noPhotoVehicle = await createVehicle(owner);
  assert.equal(noPhotoVehicle.status, 201);
  assert.deepEqual(noPhotoVehicle.body.vehicle.photos, []);
  assert.equal(noPhotoVehicle.body.vehicle.status, "READY");
  const publicVehicles = await json(`${base}/api/public/vehicles`);
  const listed = publicVehicles.body.vehicles.find((entry) => entry.id === noPhotoVehicle.body.vehicle.id);
  assert.equal(listed?.status, "READY");
  for (const hidden of ["vin", "plateNumber", "notes"]) assert.equal(listed[hidden], undefined, `public vehicles must not expose ${hidden}`);
  assert.equal(listed.mileage, 0, "public vehicles show mileage");
  const duplicatePlate = await createVehicle(owner, { vin: "1M8GDM9AXKP042702" });
  assert.deepEqual({ status: duplicatePlate.status, code: duplicatePlate.body.code }, { status: 409, code: "DUPLICATE_PLATE_NUMBER" });
  const duplicateVin = await createVehicle(owner, { plateNumber: "PACKET-OTHER-PLATE" });
  assert.deepEqual({ status: duplicateVin.status, code: duplicateVin.body.code }, { status: 409, code: "DUPLICATE_VIN" });
  assert.equal((await createVehicle(staff, { plateNumber: "PACKET-STAFF", vin: "1M8GDM9AXKP042703" })).status, 403);
  assert.equal((await json(`${base}${issuePath}`, { method: "POST" })).status, 401);
  assert.equal((await json(`${base}${issuePath}`, { method: "POST", headers: { Cookie: owner.cookie } })).status, 403);
  const issued = await json(`${base}${issuePath}`, { method: "POST", headers: { Cookie: owner.cookie, "x-csrf-token": owner.csrf }, body: "{}" }); assert.equal(issued.status, 200); const accessToken = issued.body.accessToken; assert.match(accessToken, /^[A-Za-z0-9_-]{43}$/); assert.equal(Object.hasOwn(issued.body, "hash"), false);
  const stored = await pool.query("SELECT customer_access_token_hash FROM reservationsmvp WHERE reservationid=$1", [reservations.rows[0].reservationid]); assert.equal(stored.rows[0].customer_access_token_hash, crypto.createHash("sha256").update(accessToken).digest("hex")); assert.equal(stored.rows[0].customer_access_token_hash.includes(accessToken), false);
  const lookup = await json(`${base}/api/public/reservation-access`, { headers: { "X-Reservation-Access-Token": accessToken } }); assert.equal(lookup.status, 200); assert.equal(lookup.body.reservation.reservationNumber.includes(String(reservations.rows[1].reservationid)), false); assert.equal(Object.hasOwn(lookup.body.reservation, "reservationId"), false); assert.equal((await json(`${base}/api/public/reservation-access`, { headers: { "X-Reservation-Access-Token": crypto.randomBytes(32).toString("base64url") } })).status, 401);
  const rotated = await json(`${base}/api/admin/reservations/${reservations.rows[0].reservationid}/access/rotate`, { method: "POST", headers: { Cookie: owner.cookie, "x-csrf-token": owner.csrf }, body: "{}" }); assert.equal(rotated.status, 200); assert.notEqual(rotated.body.accessToken, accessToken); assert.equal((await json(`${base}/api/public/reservation-access`, { headers: { "X-Reservation-Access-Token": accessToken } })).status, 401); assert.equal((await json(`${base}/api/public/reservation-access`, { headers: { "X-Reservation-Access-Token": rotated.body.accessToken } })).status, 200);
  assert.equal((await json(`${base}/api/admin/reservations/${reservations.rows[0].reservationid}/access/revoke`, { method: "POST", headers: { Cookie: owner.cookie, "x-csrf-token": owner.csrf }, body: "{}" })).status, 204); assert.equal((await json(`${base}/api/public/reservation-access`, { headers: { "X-Reservation-Access-Token": rotated.body.accessToken } })).status, 401);
  const staffIssued = await json(`${base}/api/admin/reservations/${reservations.rows[1].reservationid}/access/issue`, { method: "POST", headers: { Cookie: staff.cookie, "x-csrf-token": staff.csrf }, body: "{}" }); assert.equal(staffIssued.status, 200);

  const customerAccessToken = crypto.randomBytes(32).toString("base64url");
  const bookingHeaders = { "Idempotency-Key": "public-pay-at-pickup-access-flow-0001", "X-Reservation-Access-Token": customerAccessToken };
  const bookingInput = {
    vehicleId: vehicle.rows[0].vehicleid,
    customerName: "Pay At Pickup Customer",
    customerEmail: "pay-at-pickup@packet.test",
    customerPhone: "+15550000003",
    pickupAt: "2034-01-10T10:00:00Z",
    returnAt: "2034-01-12T10:00:00Z"
  };
  const booking = await json(`${base}/api/reservations`, { method: "POST", headers: bookingHeaders, body: JSON.stringify(bookingInput) });
  assert.equal(booking.status, 201);
  assert.equal(booking.body.reservation.accessToken, customerAccessToken);
  assert.deepEqual(booking.body.reservation.payment, {
    method: "PAY_AT_PICKUP",
    status: "UNPAID",
    amountDue: 20,
    depositDue: 10,
    message: "Payment and any required deposit are collected at pickup."
  });
  assert.doesNotMatch(JSON.stringify(booking.body), /stripe/i);
  const replay = await json(`${base}/api/reservations`, { method: "POST", headers: bookingHeaders, body: JSON.stringify(bookingInput) });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotent-replay"), "true");
  assert.equal(replay.body.reservation.accessToken, customerAccessToken);
  const customerLookup = await json(`${base}/api/public/reservation-access`, { headers: { "X-Reservation-Access-Token": customerAccessToken } });
  assert.equal(customerLookup.status, 200);
  assert.equal(customerLookup.body.reservation.payment.method, "PAY_AT_PICKUP");
  assert.equal(customerLookup.body.reservation.cancellationEligible, true);
  assert.equal(Object.hasOwn(customerLookup.body.reservation, "reservationId"), false);
  const cancelled = await json(`${base}/api/public/reservation-access/cancel`, {
    method: "POST",
    headers: { "X-Reservation-Access-Token": customerAccessToken },
    body: JSON.stringify({ expectedStatusVersion: customerLookup.body.reservation.statusVersion })
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.reservation.status, "CANCELLED");
  assert.equal(cancelled.body.reservation.cancellationEligible, false);
  const cancellationAudit = await pool.query("SELECT action, admin_user_id FROM admin_audit_logs WHERE action='CUSTOMER_RESERVATION_CANCEL'");
  assert.deepEqual(cancellationAudit.rows, [{ action: "CUSTOMER_RESERVATION_CANCEL", admin_user_id: null }]);
  const secondCancel = await json(`${base}/api/public/reservation-access/cancel`, {
    method: "POST",
    headers: { "X-Reservation-Access-Token": customerAccessToken },
    body: JSON.stringify({ expectedStatusVersion: cancelled.body.reservation.statusVersion })
  });
  assert.equal(secondCancel.status, 409);
  assert.equal(secondCancel.body.code, "CUSTOMER_CANCELLATION_NOT_ELIGIBLE");
});
