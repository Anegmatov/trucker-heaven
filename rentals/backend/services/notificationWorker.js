const crypto = require("crypto");
const defaultDatabase = require("../db/connection");
const defaultSmsService = require("./smsService");
const { moduleEnv } = require("../config/env");

function workerConfig(env = moduleEnv()) {
  const positive = (name, fallback) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  return { maxAttempts: positive("NOTIFICATION_MAX_ATTEMPTS", 5), initialDelayMs: positive("NOTIFICATION_INITIAL_DELAY_MS", 30000), maxDelayMs: positive("NOTIFICATION_MAX_DELAY_MS", 3600000), leaseMs: positive("NOTIFICATION_LEASE_MS", 60000), providerTimeoutMs: positive("SMS_TIMEOUT_MS", 5000) };
}

function backoffMs(attempt, config) { return Math.min(config.maxDelayMs, config.initialDelayMs * (2 ** Math.max(0, attempt - 1))); }
function leaseToken() { return crypto.randomUUID(); }

function reservationLabel(reservation) { return [reservation.year, reservation.make, reservation.model].filter(Boolean).join(" ").trim(); }
function dateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
function renderTemplate(templateKey, reservation, templateParams = {}) {
  const officeName = moduleEnv().RENTAL_OFFICE_NAME || "Trucker Heaven Rentals";
  const officePhone = moduleEnv().RENTAL_OFFICE_PHONE || "+16154705075";
  const officeAddress = moduleEnv().RENTAL_OFFICE_ADDRESS || "8037 Eastgate Blvd, Mt. Juliet, TN 37122";
  const vehicle = reservationLabel(reservation);
  if (templateKey === "OFFICE_RESERVATION_CREATED") return { destination: officePhone, body: `New rental request: ${vehicle}, ${dateTime(reservation.pickupat)} to ${dateTime(reservation.returnat)}. Check admin dashboard.` };
  if (templateKey === "CUSTOMER_REQUEST_RECEIVED") {
    const link = /^https?:\/\//.test(String(templateParams.manageUrl || "")) ? ` View or cancel: ${templateParams.manageUrl}` : "";
    return { destination: reservation.customerphone, body: `${officeName} received your reservation request for ${vehicle}. We'll text you once it's confirmed. No payment online; pay at pickup.${link}` };
  }
  if (templateKey === "CUSTOMER_RESERVATION_CONFIRMED") return { destination: reservation.customerphone, body: `Confirmed: your ${officeName} reservation for ${vehicle} is approved. Pickup: ${dateTime(reservation.pickupat)} at ${officeAddress}.` };
  if (templateKey === "CUSTOMER_RESERVATION_DECLINED") return { destination: reservation.customerphone, body: `Sorry, ${vehicle} is not available for the requested time. Please call ${officePhone} to choose another option.` };
  if (templateKey === "CUSTOMER_DRIVER_LICENSE_APPROVED") return { destination: reservation.customerphone, body: `${officeName}: your driver license document was approved.` };
  if (templateKey === "CUSTOMER_INSURANCE_APPROVED") return { destination: reservation.customerphone, body: `${officeName}: your insurance document was approved.` };
  if (["CUSTOMER_DRIVER_LICENSE_REJECTED", "CUSTOMER_INSURANCE_REJECTED"].includes(templateKey)) {
    const label = templateKey.includes("DRIVER_LICENSE") ? "driver license" : "insurance";
    const instruction = String(templateParams.customerInstruction || "").trim().slice(0, 320);
    return { destination: reservation.customerphone, body: `${officeName}: your ${label} document needs attention.${instruction ? ` ${instruction}` : ` Please contact ${officePhone}.`}` };
  }
  if (templateKey === "CUSTOMER_DOCUMENTS_APPROVED") return { destination: reservation.customerphone, body: `${officeName}: your current driver license and insurance documents are approved.` };
  return null;
}

async function claimNext(database, config) {
  const client = await database.connect();
  const token = leaseToken();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH candidate AS (
         SELECT id FROM notification_outbox
          WHERE (status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at <= CURRENT_TIMESTAMP)
             OR (status = 'PROCESSING' AND lease_expires_at <= CURRENT_TIMESTAMP)
          ORDER BY next_attempt_at ASC, id ASC FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE notification_outbox o SET status = 'PROCESSING', lease_token = $1,
          lease_expires_at = CURRENT_TIMESTAMP + ($2 * INTERVAL '1 millisecond'), updated_at = CURRENT_TIMESTAMP
         FROM candidate WHERE o.id = candidate.id RETURNING o.*`, [token, config.leaseMs]
    );
    await client.query("COMMIT");
    return result.rows[0] ? { notification: result.rows[0], token } : null;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

async function finishAttempt(database, claimed, result, durationMs, config) {
  const notification = claimed.notification;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM notification_outbox WHERE id = $1 AND status = 'PROCESSING' AND lease_token = $2 FOR UPDATE", [notification.id, claimed.token]);
    if (!locked.rowCount) { await client.query("ROLLBACK"); return false; }
    const attemptNumber = Number(locked.rows[0].attempt_count) + 1;
    let status;
    let nextAttempt = null;
    const code = result.ambiguous ? "DELIVERY_OUTCOME_UNKNOWN" : (result.code || null);
    if (result.status === "sent") status = "SENT";
    else if (result.status === "skipped") status = "SKIPPED";
    else if (result.ambiguous || !result.retryable || attemptNumber >= config.maxAttempts) status = "DEAD_LETTER";
    else { status = "RETRY_WAIT"; nextAttempt = backoffMs(attemptNumber, config); }
    await client.query(
      `INSERT INTO notification_attempts (notification_id, attempt_number, result, safe_error_code, provider_message_id, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`, [notification.id, attemptNumber, status, code, result.providerMessageId || null, durationMs]
    );
    await client.query(
      `UPDATE notification_outbox SET status = $1::varchar, attempt_count = $2, next_attempt_at = CASE WHEN $3::integer IS NULL THEN next_attempt_at ELSE CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond') END,
         lease_token = NULL, lease_expires_at = NULL, provider_message_id = COALESCE($4, provider_message_id), provider_status = $5,
         last_error_code = $6, sent_at = CASE WHEN $1::text = 'SENT' THEN CURRENT_TIMESTAMP ELSE sent_at END, updated_at = CURRENT_TIMESTAMP,
         template_params = CASE WHEN $1::text IN ('SENT', 'DEAD_LETTER', 'SKIPPED') THEN template_params - 'manageUrl' ELSE template_params END
       WHERE id = $7 AND lease_token = $8`, [status, attemptNumber, nextAttempt, result.providerMessageId || null, result.status === "sent" ? "ACCEPTED" : status, code, notification.id, claimed.token]
    );
    await client.query("COMMIT");
    return true;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

async function processOne({ database = defaultDatabase, smsService = defaultSmsService, config = workerConfig() } = {}) {
  const claimed = await claimNext(database, config);
  if (!claimed) return { processed: false };
  const started = Date.now();
  let result;
  try {
    const reservationResult = await database.query("SELECT r.*, v.make, v.model, v.year FROM reservationsmvp r JOIN vehicles v ON v.vehicleid = r.vehicleid WHERE r.reservationid = $1", [claimed.notification.reservation_id]);
    const rendered = reservationResult.rows[0] && renderTemplate(
      claimed.notification.template_key,
      reservationResult.rows[0],
      claimed.notification.template_params
    );
    result = !rendered ? { status: "skipped", code: "INVALID_TEMPLATE" } : await smsService.sendSms(rendered.destination, rendered.body);
  } catch (_error) { result = { status: "failed", code: "DELIVERY_OUTCOME_UNKNOWN", ambiguous: true }; }
  await finishAttempt(database, claimed, result, Date.now() - started, config);
  return { processed: true, status: result.status };
}

async function runWorker({ database = defaultDatabase, smsService = defaultSmsService, config = workerConfig(), pollMs = 1000 } = {}) {
  let stopping = false;
  let timer = null;
  let resolveSleep = null;
  const stop = () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    if (resolveSleep) resolveSleep();
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    while (!stopping) {
      const outcome = await processOne({ database, smsService, config });
      if (!outcome.processed && !stopping) await new Promise((resolve) => {
        resolveSleep = resolve;
        timer = setTimeout(resolve, pollMs);
      });
      timer = null; resolveSleep = null;
    }
  } finally {
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    await database.end();
  }
}

module.exports = { backoffMs, claimNext, finishAttempt, processOne, renderTemplate, runWorker, workerConfig };
