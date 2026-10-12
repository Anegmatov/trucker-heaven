const crypto = require("crypto");
const { formatReservationRequestNumber } = require("../utils/reservationNumber");
const { writeAudit } = require("./adminAuthService");
const { enqueueLifecycleNotification } = require("./notificationOutboxService");
const { RESERVATION_STATUSES, isAllowedReservationTransition, normalizeReservationStatus } = require("../utils/reservationPolicy");
const { isGrant, issueGrant, verifyGrant } = require("../utils/accessGrant");

function tokenHash(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function issueToken() { return crypto.randomBytes(32).toString("base64url"); }
function error(statusCode, message, code = "") { const value = new Error(message); value.statusCode = statusCode; value.code = code; return value; }
function validToken(token) { return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token); }

function paymentSummary(row, ledger = null) {
  const amountDue = ledger ? Math.max(0, ledger.balanceCents) / 100 : Number(row.estimatedtotal || 0);
  return {
    method: "PAY_AT_PICKUP",
    status: ledger?.settled && ledger.paidCents > 0 ? "PAID" : ledger?.paidCents > 0 ? "PARTIAL" : "UNPAID",
    total: ledger ? ledger.totalCents / 100 : Number(row.estimatedtotal || 0),
    paid: ledger ? ledger.paidCents / 100 : 0,
    amountDue,
    depositDue: Number(row.depositamount || 0),
    message: "Nothing is charged online. You pay at the counter when you pick up the vehicle."
  };
}

function customerReservationResponse(row, ledger = null) {
  const status = normalizeReservationStatus(row.status) || row.status;
  return {
    reservationNumber: formatReservationRequestNumber(row.reservationid),
    status,
    statusVersion: Number(row.statusversion || 1),
    customerName: row.customername || "",
    vehicle: {
      description: [row.year, row.make, row.model].filter(Boolean).join(" ")
    },
    pickupAt: row.pickupat,
    returnAt: row.returnat,
    pickupLocation: row.locationname,
    payment: paymentSummary(row, ledger),
    bringToCounter: ["Your driver license", "Proof of insurance", "A card or cash for payment and deposit"],
    cancellationEligible: [RESERVATION_STATUSES.PENDING_REQUEST, RESERVATION_STATUSES.CONFIRMED, RESERVATION_STATUSES.READY_FOR_PICKUP].includes(status),
    completed: status === RESERVATION_STATUSES.COMPLETED
  };
}

// Accepts the private access token (texted to the customer) or a short-lived grant from the
// email + phone lookup; both open the same reservation page.
async function reservationRowForAccessToken(database, token, { lock = false } = {}) {
  const grantId = isGrant(token) ? verifyGrant(token) : null;
  if (!grantId && !validToken(token)) throw error(401, "Reservation access is invalid", "RESERVATION_ACCESS_INVALID");
  const result = await database.query(
    `SELECT r.*, v.make, v.model, v.year, v.platenumber, v.locationname
       FROM reservationsmvp r
       JOIN vehicles v ON v.vehicleid = r.vehicleid
      WHERE ${grantId ? "r.reservationid = $1" : "r.customer_access_token_hash = $1"}${lock ? " FOR UPDATE OF r" : ""}`,
    [grantId || tokenHash(token)]
  );
  if (!result.rowCount) throw error(401, "Reservation access is invalid", "RESERVATION_ACCESS_INVALID");
  return result.rows[0];
}

async function replaceAccessToken(database, reservationId) {
  const id = Number(reservationId); if (!Number.isInteger(id) || id < 1) throw error(400, "Invalid reservation");
  const token = issueToken(); const result = await database.query("UPDATE reservationsmvp SET customer_access_token_hash = $1, updatedat = CURRENT_TIMESTAMP WHERE reservationid = $2 RETURNING reservationid", [tokenHash(token), id]);
  if (!result.rowCount) throw error(404, "Reservation not found");
  return token;
}
async function revokeAccessToken(database, reservationId) {
  const result = await database.query("UPDATE reservationsmvp SET customer_access_token_hash = NULL, updatedat = CURRENT_TIMESTAMP WHERE reservationid = $1 RETURNING reservationid", [reservationId]);
  if (!result.rowCount) throw error(404, "Reservation not found");
}
async function customerReservation(database, token) {
  const row = await reservationRowForAccessToken(database, token);
  const { readCounter } = require("./rentalCounterService");
  const counter = await readCounter(database, row.reservationid);
  return customerReservationResponse(row, counter.ledger);
}

async function cancelCustomerReservation({ database, token, expectedStatusVersion }) {
  const version = Number(expectedStatusVersion);
  if (!Number.isInteger(version) || version < 1) throw error(400, "expectedStatusVersion must be a positive integer", "INVALID_STATUS_VERSION");
  const client = await database.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const reservation = await reservationRowForAccessToken(client, token, { lock: true });
    const current = normalizeReservationStatus(reservation.status);
    if (Number(reservation.statusversion) !== version) {
      throw error(409, "Reservation state changed. Refresh and review the current request.", "RESERVATION_STATE_CONFLICT");
    }
    if (![RESERVATION_STATUSES.PENDING_REQUEST, RESERVATION_STATUSES.CONFIRMED, RESERVATION_STATUSES.READY_FOR_PICKUP].includes(current)
      || !isAllowedReservationTransition(current, RESERVATION_STATUSES.CANCELLED)) {
      throw error(409, "This reservation is no longer eligible for online cancellation. Contact the rental office for assistance.", "CUSTOMER_CANCELLATION_NOT_ELIGIBLE");
    }
    const updated = await client.query(
      `UPDATE reservationsmvp
          SET status = $1, statusversion = statusversion + 1, updatedat = CURRENT_TIMESTAMP
        WHERE reservationid = $2 AND statusversion = $3
        RETURNING *`,
      [RESERVATION_STATUSES.CANCELLED, reservation.reservationid, version]
    );
    if (updated.rowCount !== 1) throw error(409, "Reservation state changed. Refresh and review the current request.", "RESERVATION_STATE_CONFLICT");
    const next = updated.rows[0];
    await client.query(
      `INSERT INTO reservation_status_history
        (reservation_id, from_status, to_status, status_version, actor_admin_user_id, operation, reason)
       VALUES ($1, $2, $3, $4, NULL, 'CANCEL', $5)`,
      [reservation.reservationid, current, RESERVATION_STATUSES.CANCELLED, next.statusversion, "Customer cancelled through secure reservation access"]
    );
    await writeAudit(client, null, "CUSTOMER_RESERVATION_CANCEL", "RESERVATION", reservation.reservationid, {
      fromStatus: current,
      toStatus: RESERVATION_STATUSES.CANCELLED,
      statusVersion: next.statusversion
    });
    await enqueueLifecycleNotification(client, { ...reservation, ...next, reservationid: reservation.reservationid }, "CANCEL");
    await client.query("COMMIT");
    begun = false;
    return customerReservation(database, token);
  } catch (caught) {
    if (begun) await client.query("ROLLBACK").catch(() => undefined);
    throw caught;
  } finally {
    client.release();
  }
}

// Customers find their rentals with the email and mobile number they booked with (same as the
// parking site). Matching is on normalized email and the last 10 digits of the phone number.
function normalizeLookupEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 160 ? email : null;
}
function normalizeLookupPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return digits.slice(-10);
}
async function findCustomerReservations(database, { email, phone } = {}) {
  const normalizedEmail = normalizeLookupEmail(email);
  const normalizedPhone = normalizeLookupPhone(phone);
  if (!normalizedEmail || !normalizedPhone) throw error(400, "Enter the email address and mobile number you reserved with.", "INVALID_LOOKUP");
  const result = await database.query(
    `SELECT r.reservationid, r.status, r.pickupat, r.returnat, v.make, v.model, v.year
       FROM reservationsmvp r
       JOIN vehicles v ON v.vehicleid = r.vehicleid
      WHERE lower(trim(r.customeremail)) = $1
        AND right(regexp_replace(coalesce(r.customerphone, ''), '\\D', '', 'g'), 10) = $2
      ORDER BY r.pickupat DESC, r.reservationid DESC
      LIMIT 20`,
    [normalizedEmail, normalizedPhone]
  );
  return result.rows.map((row) => ({
    reservationNumber: formatReservationRequestNumber(row.reservationid),
    status: normalizeReservationStatus(row.status) || row.status,
    vehicle: { description: [row.year, row.make, row.model].filter(Boolean).join(" ") },
    pickupAt: row.pickupat,
    returnAt: row.returnat,
    accessGrant: issueGrant(row.reservationid)
  }));
}

module.exports = {
  cancelCustomerReservation,
  findCustomerReservations,
  customerReservation,
  customerReservationResponse,
  issueToken,
  replaceAccessToken,
  reservationRowForAccessToken,
  revokeAccessToken,
  tokenHash,
  validToken
};
