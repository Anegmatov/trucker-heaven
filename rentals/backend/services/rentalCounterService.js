// Counter checkout and in-person payments for rentals.
//
// Customers never pay online. At pickup staff confirm three things at the counter (driver license,
// insurance, signed paper agreement) and collect payment and any deposit. At return they add any
// extra charges (late return, fuel, cleaning, damage), settle the balance and refund the deposit.
const { writeAudit } = require("./adminAuthService");

const PAYMENT_KINDS = Object.freeze(["PAYMENT", "REFUND", "DEPOSIT", "DEPOSIT_REFUND"]);
const PAYMENT_METHODS = Object.freeze(["CASH", "CARD", "CLOVER", "CHECK", "OTHER"]);
const CHECK_KEYS = Object.freeze({ license: "license", insurance: "insurance", agreement: "agreement" });

function fail(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function dollarsToCents(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function wholeCents(value, label, { allowNegative = false } = {}) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount === 0 || (!allowNegative && amount < 0) || Math.abs(amount) > 10000000) {
    throw fail(400, `${label} must be a whole number of cents${allowNegative ? "" : " above zero"}`, "INVALID_AMOUNT");
  }
  return amount;
}

function optionalText(value, max, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw fail(400, `${label} is invalid`, "INVALID_TEXT");
  const text = value.trim();
  if (text.length > max) throw fail(400, `${label} is too long`, "INVALID_TEXT");
  return text || null;
}

function reservationId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Invalid reservation", "INVALID_RESERVATION");
  return id;
}

async function lockReservation(client, id) {
  const row = (await client.query("SELECT * FROM reservationsmvp WHERE reservationid = $1 FOR UPDATE", [id])).rows[0];
  if (!row) throw fail(404, "Reservation not found", "RESERVATION_NOT_FOUND");
  return row;
}

function checksView(row) {
  const item = (at, by) => ({ done: Boolean(at), at: at || null, by: by || null });
  return {
    license: item(row?.license_verified_at, row?.license_verified_by_email),
    insurance: item(row?.insurance_verified_at, row?.insurance_verified_by_email),
    agreement: item(row?.agreement_signed_at, row?.agreement_signed_by_email),
    note: row?.note || "",
    complete: Boolean(row?.license_verified_at && row?.insurance_verified_at && row?.agreement_signed_at)
  };
}

function summarize(reservation, charges, payments) {
  const sum = (rows, kinds) => rows.filter((row) => kinds.includes(row.kind)).reduce((total, row) => total + Number(row.amount_cents), 0);
  const rentalCents = dollarsToCents(reservation.estimatedtotal);
  const chargesCents = charges.reduce((total, row) => total + Number(row.amount_cents), 0);
  const paidCents = sum(payments, ["PAYMENT"]) - sum(payments, ["REFUND"]);
  const totalCents = rentalCents + chargesCents;
  const depositRequiredCents = dollarsToCents(reservation.depositamount);
  const depositHeldCents = sum(payments, ["DEPOSIT"]) - sum(payments, ["DEPOSIT_REFUND"]);
  return {
    rentalCents,
    chargesCents,
    totalCents,
    paidCents,
    balanceCents: totalCents - paidCents,
    depositRequiredCents,
    depositHeldCents,
    settled: totalCents - paidCents <= 0
  };
}

async function readCounter(database, id) {
  const reservation = (await database.query("SELECT * FROM reservationsmvp WHERE reservationid = $1", [id])).rows[0];
  if (!reservation) throw fail(404, "Reservation not found", "RESERVATION_NOT_FOUND");
  const checks = (await database.query(`SELECT c.*, l.email license_verified_by_email, i.email insurance_verified_by_email, a.email agreement_signed_by_email
      FROM rental_counter_checks c
      LEFT JOIN admin_users l ON l.id = c.license_verified_by
      LEFT JOIN admin_users i ON i.id = c.insurance_verified_by
      LEFT JOIN admin_users a ON a.id = c.agreement_signed_by
     WHERE c.reservation_id = $1`, [id])).rows[0];
  const charges = (await database.query(`SELECT c.*, u.email created_by_email FROM rental_charges c
      LEFT JOIN admin_users u ON u.id = c.created_by WHERE c.reservation_id = $1 ORDER BY c.created_at, c.id`, [id])).rows;
  const payments = (await database.query(`SELECT p.*, u.email recorded_by_email FROM rental_payments p
      LEFT JOIN admin_users u ON u.id = p.recorded_by WHERE p.reservation_id = $1 ORDER BY p.recorded_at, p.id`, [id])).rows;
  return {
    checks: checksView(checks),
    ledger: summarize(reservation, charges, payments),
    charges: charges.map((row) => ({ id: Number(row.id), description: row.description, amountCents: Number(row.amount_cents), createdAt: row.created_at, createdBy: row.created_by_email || null })),
    payments: payments.map((row) => ({ id: Number(row.id), kind: row.kind, method: row.method, amountCents: Number(row.amount_cents), reference: row.reference || "", note: row.note || "", recordedAt: row.recorded_at, recordedBy: row.recorded_by_email || null }))
  };
}

async function inTransaction(database, work) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

const CHECKABLE_STATUSES = ["CONFIRMED", "READY_FOR_PICKUP", "CHECKED_OUT"];

async function updateChecks(database, { reservationId: rawId, checks = {}, note, actor }) {
  const id = reservationId(rawId);
  return inTransaction(database, async (client) => {
    const reservation = await lockReservation(client, id);
    if (!CHECKABLE_STATUSES.includes(String(reservation.status).toUpperCase())) {
      throw fail(409, "Counter checks can be changed once the reservation is confirmed and before it is returned", "COUNTER_CHECKS_LOCKED");
    }
    const current = (await client.query("SELECT * FROM rental_counter_checks WHERE reservation_id = $1 FOR UPDATE", [id])).rows[0] || {};
    const next = { ...current };
    const apply = (key, atColumn, byColumn) => {
      if (checks[key] === undefined) return;
      if (typeof checks[key] !== "boolean") throw fail(400, `${key} must be true or false`, "INVALID_CHECK");
      if (checks[key] && !current[atColumn]) { next[atColumn] = new Date(); next[byColumn] = actor.id; }
      if (!checks[key]) { next[atColumn] = null; next[byColumn] = null; }
    };
    apply(CHECK_KEYS.license, "license_verified_at", "license_verified_by");
    apply(CHECK_KEYS.insurance, "insurance_verified_at", "insurance_verified_by");
    apply(CHECK_KEYS.agreement, "agreement_signed_at", "agreement_signed_by");
    const nextNote = note === undefined ? current.note || null : optionalText(note, 1000, "Note");
    await client.query(`INSERT INTO rental_counter_checks
        (reservation_id, license_verified_at, license_verified_by, insurance_verified_at, insurance_verified_by,
         agreement_signed_at, agreement_signed_by, note, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
      ON CONFLICT (reservation_id) DO UPDATE SET
        license_verified_at = EXCLUDED.license_verified_at, license_verified_by = EXCLUDED.license_verified_by,
        insurance_verified_at = EXCLUDED.insurance_verified_at, insurance_verified_by = EXCLUDED.insurance_verified_by,
        agreement_signed_at = EXCLUDED.agreement_signed_at, agreement_signed_by = EXCLUDED.agreement_signed_by,
        note = EXCLUDED.note, updated_at = CURRENT_TIMESTAMP`, [
      id, next.license_verified_at || null, next.license_verified_by || null, next.insurance_verified_at || null,
      next.insurance_verified_by || null, next.agreement_signed_at || null, next.agreement_signed_by || null, nextNote
    ]);
    await writeAudit(client, actor.id, "RENTAL_COUNTER_CHECKS_UPDATED", "RESERVATION", id, {
      license: Boolean(next.license_verified_at), insurance: Boolean(next.insurance_verified_at), agreement: Boolean(next.agreement_signed_at)
    });
    return null;
  }).then(() => readCounter(database, id));
}

const PAYABLE_STATUSES = ["CONFIRMED", "READY_FOR_PICKUP", "CHECKED_OUT", "RETURNED_PENDING_INSPECTION", "COMPLETED", "CANCELLED", "NO_SHOW"];

async function recordPayment(database, { reservationId: rawId, kind, method, amountCents, reference, note, actor }) {
  const id = reservationId(rawId);
  const paymentKind = String(kind || "").toUpperCase();
  const paymentMethod = String(method || "").toUpperCase();
  if (!PAYMENT_KINDS.includes(paymentKind)) throw fail(400, "Choose payment, refund, deposit or deposit refund", "INVALID_PAYMENT_KIND");
  if (!PAYMENT_METHODS.includes(paymentMethod)) throw fail(400, "Choose cash, card, Clover, check or other", "INVALID_PAYMENT_METHOD");
  const amount = wholeCents(amountCents, "Amount");
  const ref = optionalText(reference, 120, "Reference");
  const memo = optionalText(note, 500, "Note");
  await inTransaction(database, async (client) => {
    const reservation = await lockReservation(client, id);
    if (!PAYABLE_STATUSES.includes(String(reservation.status).toUpperCase())) {
      throw fail(409, "Payments can be recorded once the reservation is confirmed", "PAYMENT_NOT_ALLOWED");
    }
    const counter = await readCounter(client, id);
    if (paymentKind === "REFUND" && amount > counter.ledger.paidCents) throw fail(409, "A refund cannot be more than what was paid", "REFUND_TOO_LARGE");
    if (paymentKind === "DEPOSIT_REFUND" && amount > counter.ledger.depositHeldCents) throw fail(409, "A deposit refund cannot be more than the deposit held", "DEPOSIT_REFUND_TOO_LARGE");
    const inserted = (await client.query(`INSERT INTO rental_payments (reservation_id, kind, method, amount_cents, reference, note, recorded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [id, paymentKind, paymentMethod, amount, ref, memo, actor.id])).rows[0];
    await writeAudit(client, actor.id, "RENTAL_PAYMENT_RECORDED", "RESERVATION", id, { paymentId: Number(inserted.id), kind: paymentKind, method: paymentMethod, amountCents: amount });
  });
  return readCounter(database, id);
}

async function addCharge(database, { reservationId: rawId, description, amountCents, actor }) {
  const id = reservationId(rawId);
  const text = optionalText(description, 200, "Description");
  if (!text) throw fail(400, "Describe the charge", "INVALID_TEXT");
  const amount = wholeCents(amountCents, "Amount", { allowNegative: true });
  await inTransaction(database, async (client) => {
    const reservation = await lockReservation(client, id);
    if (!["CONFIRMED", "READY_FOR_PICKUP", "CHECKED_OUT", "RETURNED_PENDING_INSPECTION"].includes(String(reservation.status).toUpperCase())) {
      throw fail(409, "Charges can be added while the reservation is active", "CHARGE_NOT_ALLOWED");
    }
    const counter = await readCounter(client, id);
    if (counter.ledger.totalCents + amount < 0) throw fail(409, "A discount cannot make the total negative", "DISCOUNT_TOO_LARGE");
    const inserted = (await client.query("INSERT INTO rental_charges (reservation_id, description, amount_cents, created_by) VALUES ($1, $2, $3, $4) RETURNING id", [id, text, amount, actor.id])).rows[0];
    await writeAudit(client, actor.id, "RENTAL_CHARGE_ADDED", "RESERVATION", id, { chargeId: Number(inserted.id), amountCents: amount });
  });
  return readCounter(database, id);
}

// Used by the lifecycle gates in reservationTransitionService.
async function assertReadyForCheckout(client, id) {
  const counter = await readCounter(client, id);
  if (!counter.checks.complete) {
    throw fail(409, "Check the driver license and insurance, and get the agreement signed, before checkout", "COUNTER_CHECKS_REQUIRED");
  }
  return counter;
}

async function assertSettled(client, id) {
  const counter = await readCounter(client, id);
  if (!counter.ledger.settled) throw fail(409, "Collect the remaining balance before completing the rental", "BALANCE_DUE");
  return counter;
}

module.exports = {
  PAYMENT_KINDS, PAYMENT_METHODS, readCounter, updateChecks, recordPayment, addCharge,
  assertReadyForCheckout, assertSettled, summarize, dollarsToCents
};
