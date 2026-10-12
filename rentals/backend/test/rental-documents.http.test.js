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
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const INTERNAL_NOTE = "internal-only-review-note";
const CUSTOMER_INSTRUCTION = "Please upload a current policy card.";

function webp() {
  const value = Buffer.alloc(30);
  value.write("RIFF", 0, "ascii");
  value.writeUInt32LE(22, 4);
  value.write("WEBPVP8X", 8, "ascii");
  value.writeUInt32LE(10, 16);
  value.writeUIntLE(0, 20, 4);
  value.writeUIntLE(0, 24, 3);
  value.writeUIntLE(0, 27, 3);
  return value;
}

function disposable(value) {
  try { return /(?:test|testing|disposable)/i.test(new URL(value).pathname); } catch (_error) { return false; }
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function response(url, options = {}) {
  const result = await fetch(url, options);
  const buffer = Buffer.from(await result.arrayBuffer());
  const text = buffer.toString("utf8");
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_error) { body = null; }
  return { status: result.status, headers: result.headers, buffer, text, body };
}

async function json(url, options = {}) {
  return response(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
}

function sessionCookie(result) { return String(result.headers.get("set-cookie") || "").split(";", 1)[0]; }

async function upload(baseUrl, { token, documentType, filename, mimeType, content, suffix = "" }) {
  const form = new FormData();
  form.append("file", new Blob([content], { type: mimeType }), filename);
  return response(`${baseUrl}/api/public/reservation-access/documents/${documentType}${suffix}`, {
    method: "POST",
    headers: { "X-Reservation-Access-Token": token },
    body: form
  });
}

async function privateFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name !== ".gitignore").map((entry) => entry.name).sort();
}

async function runMigration(environment) {
  const child = spawn(process.execPath, ["migrations/run.js"], {
    cwd: path.join(__dirname, ".."), env: environment, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (value) => { output += value; });
  child.stderr.on("data", (value) => { output += value; });
  await new Promise((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(output))));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
}

async function waitForReady(baseUrl) {
  let lastStatus = "unreachable";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const result = await response(`${baseUrl}/api/health/ready`);
      lastStatus = `${result.status}:${result.text}`;
      if (result.status === 200 && result.body?.ok === true) return;
    } catch (_error) {
      lastStatus = "unreachable";
    }
    await wait(100);
  }
  throw new Error(`server readiness did not succeed (${lastStatus})`);
}

test("rental documents use the real server, PostgreSQL, auth, private storage, and document gates", async (t) => {
  if (!databaseUrl) return t.skip("TEST_DATABASE_URL is required");
  assert.equal(disposable(databaseUrl), true, "TEST_DATABASE_URL must be disposable");

  const uploadParent = await fs.mkdtemp(path.join(os.tmpdir(), "driveops-rental-documents-"));
  const uploadDir = path.join(uploadParent, "private-documents");
  const pool = new Pool({ connectionString: databaseUrl });
  const serverPort = await freePort();
  const environment = {
    ...process.env,
    RENTALS_DATABASE_URL: databaseUrl,
    PORT: String(serverPort),
    NODE_ENV: "test",
    RENTALS_CORS_ALLOWED_ORIGINS: "http://localhost:5174",
    RENTALS_COOKIE_SECURE: "false",
    RENTALS_SESSION_TOKEN_PEPPER: "packet-2-document-test-pepper",
    RENTALS_RENTAL_UPLOAD_DIR: uploadDir,
    RENTALS_RENTAL_DOCUMENT_MAX_BYTES: String(6 * 1024 * 1024),
    RENTALS_RESERVATION_RATE_LIMIT_MAX: "100",
    RENTALS_SMS_ENABLED: "false"
  };
  let child;
  t.after(async () => {
    await stopChild(child).catch(() => undefined);
    await pool.end().catch(() => undefined);
    await fs.rm(uploadParent, { recursive: true, force: true });
  });

  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
  await runMigration(environment);
  const migrations = await pool.query("SELECT migration FROM schema_migrations WHERE migration IN ('010_rental_completion_documents_agreements.sql', '011_rental_document_review_history.sql') ORDER BY migration");
  assert.deepEqual(migrations.rows.map((row) => row.migration), ["010_rental_completion_documents_agreements.sql", "011_rental_document_review_history.sql"]);

  const password = "PacketTwoDocumentPassword9";
  const passwordHash = await bcrypt.hash(password, 12);
  const users = await pool.query(
    "INSERT INTO admin_users (email,password_hash,role) VALUES ($1,$2,'OWNER'),($3,$2,'STAFF') RETURNING id,email,role",
    ["owner@documents.test", passwordHash, "staff@documents.test"]
  );
  const ownerUser = users.rows.find((row) => row.role === "OWNER");
  const staffUser = users.rows.find((row) => row.role === "STAFF");
  const vehicle = await pool.query("INSERT INTO vehicles (make,model,year,category,dailyrate,depositamount,mileage) VALUES ('Test','Documents',2026,'Sedan',10,10,0) RETURNING vehicleid");
  const reservations = await pool.query(
    `INSERT INTO reservationsmvp
      (vehicleid,customername,customeremail,customerphone,pickupat,returnat,status,estimatedtotal,depositamount)
     VALUES
      ($1,'Customer A','a@documents.test','+15550000001',CURRENT_TIMESTAMP + INTERVAL '2 days',CURRENT_TIMESTAMP + INTERVAL '3 days','PENDING_REQUEST',10,10),
      ($1,'Customer B','b@documents.test','+15550000002',CURRENT_TIMESTAMP + INTERVAL '4 days',CURRENT_TIMESTAMP + INTERVAL '5 days','PENDING_REQUEST',10,10)
     RETURNING reservationid,vehicleid`,
    [vehicle.rows[0].vehicleid]
  );
  const reservationA = reservations.rows[0];
  const reservationB = reservations.rows[1];

  child = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: environment, stdio: "ignore" });
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  await waitForReady(baseUrl);

  async function login(email) {
    const result = await json(`${baseUrl}/api/admin/auth/login`, { method: "POST", body: JSON.stringify({ email, password }) });
    assert.equal(result.status, 200);
    return { cookie: sessionCookie(result), csrf: result.body.csrfToken };
  }
  async function admin(method, pathname, credentials, body, includeCsrf = true) {
    return json(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(credentials ? { Cookie: credentials.cookie } : {}),
        ...(credentials && includeCsrf ? { "x-csrf-token": credentials.csrf } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  async function issueToken(reservationId, credentials) {
    const result = await admin("POST", `/api/admin/reservations/${reservationId}/access/issue`, credentials, {});
    assert.equal(result.status, 200);
    return result.body.accessToken;
  }

  const owner = await login(ownerUser.email);
  const staff = await login(staffUser.email);
  const tokenA = await issueToken(reservationA.reservationid, owner);
  const tokenB = await issueToken(reservationB.reservationid, staff);
  const tokenAHash = crypto.createHash("sha256").update(tokenA).digest("hex");
  assert.equal((await pool.query("SELECT customer_access_token_hash FROM reservationsmvp WHERE reservationid = $1", [reservationA.reservationid])).rows[0].customer_access_token_hash, tokenAHash);

  assert.equal((await response(`${baseUrl}/api/public/reservation-access/documents`)).status, 401);
  assert.equal((await response(`${baseUrl}/api/public/reservation-access/documents`, { headers: { "X-Reservation-Access-Token": crypto.randomBytes(32).toString("base64url") } })).status, 401);
  assert.equal((await admin("GET", `/api/admin/reservations/${reservationA.reservationid}/documents`)).status, 401);

  const rejectedBefore = await privateFiles(uploadDir);
  const rejected = [
    ["empty", "empty.pdf", "application/pdf", Buffer.alloc(0)],
    ["svg", "document.svg", "image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")],
    ["html", "document.html", "text/html", Buffer.from("<html>not a document</html>")],
    ["executable", "document.exe", "application/octet-stream", Buffer.from("MZ\x90\x00")],
    ["archive", "document.zip", "application/zip", Buffer.from("PK\x03\x04")],
    ["unknown", "document.bin", "application/octet-stream", Buffer.from("unknown")],
    ["mismatch", "document.pdf", "application/pdf", PNG],
    ["oversized", "large.pdf", "application/pdf", Buffer.alloc(6 * 1024 * 1024 + 1)]
  ];
  for (const [label, filename, mimeType, content] of rejected) {
    const result = await upload(baseUrl, { token: tokenB, documentType: "DRIVER_LICENSE", filename, mimeType, content });
    assert.ok([400, 413].includes(result.status), `${label} should be rejected`);
    assert.equal(result.text.includes(uploadDir), false, `${label} error must not expose a private path`);
  }
  const boundary = "packet-two-traversal";
  const traversalBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../traversal.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const traversal = await response(`${baseUrl}/api/public/reservation-access/documents/DRIVER_LICENSE`, {
    method: "POST",
    headers: { "X-Reservation-Access-Token": tokenB, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: traversalBody
  });
  assert.equal(traversal.status, 400);
  const malformed = await response(`${baseUrl}/api/public/reservation-access/documents/DRIVER_LICENSE`, {
    method: "POST",
    headers: { "X-Reservation-Access-Token": tokenB, "Content-Type": "multipart/form-data" }, body: "not multipart"
  });
  assert.equal(malformed.status, 400);
  assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM rental_documents WHERE reservation_id = $1", [reservationB.reservationid])).rows[0].count, 0);
  assert.deepEqual(await privateFiles(uploadDir), rejectedBefore);

  const privateFilesBeforeTamperedUpload = await privateFiles(uploadDir);
  const tamperedJpegUpload = await upload(baseUrl, {
    token: tokenA, documentType: "DRIVER_LICENSE", filename: "license.jpg", mimeType: "image/jpeg", content: JPEG,
    suffix: `?reservationId=${reservationB.reservationid}`
  });
  assert.equal(tamperedJpegUpload.status, 400);
  assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM rental_documents WHERE reservation_id = $1", [reservationA.reservationid])).rows[0].count, 0);
  assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM rental_documents WHERE reservation_id = $1", [reservationB.reservationid])).rows[0].count, 0);
  assert.deepEqual(await privateFiles(uploadDir), privateFilesBeforeTamperedUpload);

  const jpegUpload = await upload(baseUrl, {
    token: tokenA, documentType: "DRIVER_LICENSE", filename: "license.jpg", mimeType: "image/jpeg", content: JPEG
  });
  assert.equal(jpegUpload.status, 201);
  assert.equal(jpegUpload.body.status, "PENDING_REVIEW");
  await assert.doesNotReject(() => fs.access(uploadDir));
  assert.equal(JSON.stringify(jpegUpload.body).includes("storage_name"), false);
  assert.equal(JSON.stringify(jpegUpload.body).includes(uploadDir), false);
  assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM rental_documents WHERE reservation_id = $1", [reservationA.reservationid])).rows[0].count, 1);
  assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM rental_documents WHERE reservation_id = $1", [reservationB.reservationid])).rows[0].count, 0);
  const pngUpload = await upload(baseUrl, { token: tokenA, documentType: "INSURANCE", filename: "insurance.png", mimeType: "image/png", content: PNG });
  assert.equal(pngUpload.status, 201);

  const initialDocuments = await admin("GET", `/api/admin/reservations/${reservationA.reservationid}/documents`, owner);
  assert.equal(initialDocuments.status, 200);
  const licenseRevision1 = initialDocuments.body.documents.revisions.find((document) => document.type === "DRIVER_LICENSE");
  const insuranceRevision1 = initialDocuments.body.documents.revisions.find((document) => document.type === "INSURANCE");
  assert.equal(licenseRevision1.revision, 1);
  assert.equal(insuranceRevision1.revision, 1);
  const storedRows = await pool.query("SELECT id,storage_name,original_filename,mime_type,byte_size,review_status FROM rental_documents WHERE reservation_id = $1 ORDER BY id", [reservationA.reservationid]);
  assert.equal(storedRows.rowCount, 2);
  for (const row of storedRows.rows) {
    assert.match(row.storage_name, /^[a-f0-9]{48}\.(jpg|png)$/);
    assert.notEqual(row.storage_name, row.original_filename);
    await assert.doesNotReject(() => fs.access(path.join(uploadDir, row.storage_name)));
  }
  const documentColumns = await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='rental_documents'");
  assert.equal(documentColumns.rows.some((row) => /(content|blob|bytea|file_data)/i.test(row.column_name) || row.data_type === "bytea"), false);

  const customerAStatus = await response(`${baseUrl}/api/public/reservation-access/documents`, { headers: { "X-Reservation-Access-Token": tokenA } });
  assert.equal(customerAStatus.status, 200);
  assert.equal(customerAStatus.body.documents.driverLicense.status, "PENDING_REVIEW");
  assert.equal(JSON.stringify(customerAStatus.body).includes(INTERNAL_NOTE), false);
  const customerBDownload = await response(`${baseUrl}/api/public/reservation-access/documents/DRIVER_LICENSE/download`, { headers: { "X-Reservation-Access-Token": tokenB } });
  assert.equal(customerBDownload.status, 404);

  const approvalPath = `/api/admin/reservations/${reservationA.reservationid}/documents/${licenseRevision1.id}/approve`;
  assert.equal((await admin("POST", approvalPath)).status, 401);
  assert.equal((await admin("POST", approvalPath, owner, {}, false)).status, 403);
  assert.equal((await response(`${baseUrl}${approvalPath}`, { method: "POST", headers: { "X-Reservation-Access-Token": tokenA, "Content-Type": "application/json" }, body: "{}" })).status, 401);
  const approvedLicense = await admin("POST", approvalPath, owner, { reviewedByAdminUserId: staffUser.id, internalNote: "license internal" });
  assert.equal(approvedLicense.status, 200);
  assert.equal(approvedLicense.body.document.status, "APPROVED");
  assert.equal(approvedLicense.body.document.reviewedByAdminUserId, ownerUser.id);
  assert.equal((await admin("POST", approvalPath, owner, {})).status, 409);

  const rejectionPath = `/api/admin/reservations/${reservationA.reservationid}/documents/${insuranceRevision1.id}/reject`;
  const rejectedInsurance = await admin("POST", rejectionPath, staff, { internalNote: INTERNAL_NOTE, customerInstruction: CUSTOMER_INSTRUCTION, reviewedByAdminUserId: ownerUser.id });
  assert.equal(rejectedInsurance.status, 200);
  assert.equal(rejectedInsurance.body.document.status, "REJECTED");
  assert.equal(rejectedInsurance.body.document.reviewedByAdminUserId, staffUser.id);
  const rejectedRecord = await pool.query("SELECT review_note,customer_instruction,reviewed_by_admin_user_id FROM rental_documents WHERE id = $1", [insuranceRevision1.id]);
  assert.deepEqual(rejectedRecord.rows[0], { review_note: INTERNAL_NOTE, customer_instruction: CUSTOMER_INSTRUCTION, reviewed_by_admin_user_id: staffUser.id });
  const customerAfterRejection = await response(`${baseUrl}/api/public/reservation-access/documents`, { headers: { "X-Reservation-Access-Token": tokenA } });
  assert.equal(customerAfterRejection.body.documents.insurance.status, "REJECTED");
  assert.equal(customerAfterRejection.body.documents.insurance.instruction, CUSTOMER_INSTRUCTION);
  assert.equal(JSON.stringify(customerAfterRejection.body).includes(INTERNAL_NOTE), false);
  assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM rental_document_review_history WHERE document_id = $1", [insuranceRevision1.id])).rows[0].count, 2);
  await assert.rejects(() => pool.query("UPDATE rental_documents SET review_note = 'changed' WHERE id = $1", [licenseRevision1.id]), /immutable/);
  await assert.rejects(() => pool.query("UPDATE rental_document_review_history SET customer_instruction = 'changed' WHERE document_id = $1", [licenseRevision1.id]), /immutable/);
  await assert.rejects(() => pool.query("DELETE FROM rental_document_review_history WHERE document_id = $1", [licenseRevision1.id]), /immutable/);

  const pdfUpload = await upload(baseUrl, { token: tokenA, documentType: "INSURANCE", filename: "replacement-insurance.pdf", mimeType: "application/pdf", content: PDF });
  assert.equal(pdfUpload.status, 201);
  const afterInsuranceReplacement = await admin("GET", `/api/admin/reservations/${reservationA.reservationid}/documents`, owner);
  const insuranceRevisions = afterInsuranceReplacement.body.documents.revisions.filter((document) => document.type === "INSURANCE");
  const insuranceRevision2 = insuranceRevisions.find((document) => document.current);
  assert.equal(insuranceRevision2.revision, 2);
  assert.equal(insuranceRevision2.status, "PENDING_REVIEW");
  assert.ok(insuranceRevisions.find((document) => document.id === insuranceRevision1.id).supersededAt);
  assert.equal((await admin("POST", `/api/admin/reservations/${reservationA.reservationid}/documents/${insuranceRevision2.id}/approve`, staff, {})).status, 200);

  const webpUpload = await upload(baseUrl, { token: tokenA, documentType: "DRIVER_LICENSE", filename: "replacement-license.webp", mimeType: "image/webp", content: webp() });
  assert.equal(webpUpload.status, 201);
  const afterLicenseReplacement = await admin("GET", `/api/admin/reservations/${reservationA.reservationid}/documents`, owner);
  const licenseRevisions = afterLicenseReplacement.body.documents.revisions.filter((document) => document.type === "DRIVER_LICENSE");
  const licenseRevision2 = licenseRevisions.find((document) => document.current);
  assert.equal(licenseRevision2.revision, 2);
  assert.equal(licenseRevision2.status, "PENDING_REVIEW");
  assert.ok(licenseRevisions.find((document) => document.id === licenseRevision1.id).supersededAt);
  assert.equal((await admin("POST", approvalPath, owner, {})).status, 409);

  await pool.query("UPDATE reservationsmvp SET status='READY_FOR_PICKUP',statusversion=1 WHERE reservationid IN ($1,$2)", [reservationA.reservationid, reservationB.reservationid]);
  // Documents are optional now: the counter checklist is what gates checkout.
  const checkoutB = await admin("POST", `/api/reservations/${reservationB.reservationid}/operations/check_out`, staff, { expectedStatusVersion: 1 });
  assert.equal(checkoutB.status, 409);
  assert.equal(checkoutB.body.code, "COUNTER_CHECKS_REQUIRED");
  const partialChecks = await admin("PATCH", `/api/reservations/${reservationA.reservationid}/counter/checks`, owner, { checks: { license: true, insurance: true } });
  assert.equal(partialChecks.status, 200);
  const checkoutWithoutAgreement = await admin("POST", `/api/reservations/${reservationA.reservationid}/operations/check_out`, owner, { expectedStatusVersion: 1 });
  assert.equal(checkoutWithoutAgreement.status, 409);
  assert.equal(checkoutWithoutAgreement.body.code, "COUNTER_CHECKS_REQUIRED");
  const signed = await admin("PATCH", `/api/reservations/${reservationA.reservationid}/counter/checks`, owner, { checks: { agreement: true } });
  assert.equal(signed.body.counter.checks.complete, true);
  const checkoutWithoutInspection = await admin("POST", `/api/reservations/${reservationA.reservationid}/operations/check_out`, owner, { expectedStatusVersion: 1 });
  assert.equal(checkoutWithoutInspection.status, 409);
  assert.equal(checkoutWithoutInspection.body.code, "PICKUP_INSPECTION_REQUIRED");
  await pool.query(
    `INSERT INTO rental_inspections (reservation_id,vehicle_id,inspection_type,odometer,fuel_level_percent,damage_observed,damage_notes,cleanliness_notes,keys_count,all_expected_keys_returned,accessories_returned,accessories_notes,completed_by_admin_user_id)
     VALUES ($1,$2,'PICKUP',10,100,false,NULL,'clean',1,NULL,NULL,NULL,$3)`,
    [reservationA.reservationid, reservationA.vehicleid, ownerUser.id]
  );
  const checkoutSuccess = await admin("POST", `/api/reservations/${reservationA.reservationid}/operations/check_out`, owner, { expectedStatusVersion: 1 });
  assert.equal(checkoutSuccess.status, 200);

  const customerDownload = await response(`${baseUrl}/api/public/reservation-access/documents/DRIVER_LICENSE/download`, { headers: { "X-Reservation-Access-Token": tokenA } });
  assert.equal(customerDownload.status, 200);
  assert.equal(customerDownload.headers.get("content-type"), "image/webp");
  assert.equal(customerDownload.headers.get("x-content-type-options"), "nosniff");
  assert.match(customerDownload.headers.get("content-disposition"), /^attachment;/);
  assert.equal(customerDownload.headers.get("content-disposition").includes(licenseRevision2.displayFilename), true);
  const finalRows = await pool.query("SELECT id,storage_name FROM rental_documents WHERE reservation_id = $1 ORDER BY id", [reservationA.reservationid]);
  assert.equal(customerDownload.headers.get("content-disposition").includes(finalRows.rows.find((row) => Number(row.id) === licenseRevision2.id).storage_name), false);
  assert.deepEqual(customerDownload.buffer, webp());
  assert.equal((await response(`${baseUrl}/api/public/reservation-access/documents/%2e%2e%2fDRIVER_LICENSE/download`, { headers: { "X-Reservation-Access-Token": tokenA } })).status, 404);
  assert.equal((await response(`${baseUrl}/uploads/rentals-private/${finalRows.rows[0].storage_name}`)).status, 404);
  assert.equal((await admin("GET", `/api/admin/reservations/${reservationA.reservationid}/documents/${licenseRevision2.id}/download`, owner)).status, 200);
  assert.equal((await admin("GET", `/api/admin/reservations/${reservationA.reservationid}/documents/${licenseRevision2.id}/download`, staff)).status, 200);
  assert.equal((await admin("GET", `/api/admin/reservations/${reservationA.reservationid}/documents/${licenseRevision2.id}/download`)).status, 401);
  assert.equal((await admin("GET", `/api/admin/reservations/${reservationB.reservationid}/documents/${licenseRevision2.id}/download`, owner)).status, 404);

  const outbox = await pool.query("SELECT event_type,template_key,template_params,content_hash FROM notification_outbox WHERE reservation_id = $1 ORDER BY id", [reservationA.reservationid]);
  const eventTypes = outbox.rows.map((row) => row.event_type);
  for (const eventType of ["DRIVER_LICENSE_APPROVED", "INSURANCE_REJECTED", "INSURANCE_APPROVED"]) assert.ok(eventTypes.includes(eventType));
  assert.ok(eventTypes.includes("REQUIRED_DOCUMENTS_APPROVED"));
  const outboxText = JSON.stringify(outbox.rows);
  for (const secret of [INTERNAL_NOTE, tokenA, tokenAHash, ...finalRows.rows.map((row) => row.storage_name), PDF.toString("utf8")]) {
    assert.equal(outboxText.includes(secret), false);
  }
});
