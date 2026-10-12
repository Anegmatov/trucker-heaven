const express = require("express");
const defaultDatabase = require("../db/connection");
const { requireAdminSession, requireCsrf, requireRole } = require("../middleware/requireAdmin");
const { money } = require("../utils/vehicleMapper");
const { formatReservationRequestNumber } = require("../utils/reservationNumber");
const { logFailure } = require("../utils/safeLog");
const { writeAudit } = require("../services/adminAuthService");
const { CONFLICT_CODE, transitionReservation } = require("../services/reservationTransitionService");
const { readInspections, submitInspection } = require("../services/rentalInspectionService");
const counterService = require("../services/rentalCounterService");
const { enqueueReservationCreated, readNotificationHistory } = require("../services/notificationOutboxService");
const { issueToken, tokenHash, validToken } = require("../services/reservationAccessService");
const { moduleEnv } = require("../config/env");
const {
  BLOCKING_RESERVATION_STATUSES,
  RESERVATION_STATUSES,
  isOperationallyAvailable,
  normalizeReservationStatus
} = require("../utils/reservationPolicy");
const {
  reservationRequestHash,
  sha256,
  validateIdempotencyKey,
  validateReservationRequest
} = require("../utils/reservationRequestPolicy");

function manageUrlFor(token) {
  try {
    const site = new URL(String(moduleEnv().CUSTOMER_SITE_URL || ""));
    if (!["http:", "https:"].includes(site.protocol)) return null;
    return `${site.href.replace(/\/$/, "")}/#t=${encodeURIComponent(token)}`;
  } catch (_error) { return null; }
}

// Rental days are counted on the office's wall clock (America/Chicago), matching the estimate the
// customer saw: a 9 AM to 9 AM rental is one day per calendar day, even across a DST change.
function chicagoWallClockMs(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}

function calculateDays(start, end) {
  const diffMs = chicagoWallClockMs(end) - chicagoWallClockMs(start);
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000) - 1e-9));
}

function isAvailabilityConflict(error) {
  return error?.code === "23P01";
}

function isIdempotencyConflict(error) {
  return error?.code === "23505" && error?.constraint === "uq_reservationsmvp_idempotency_key_hash";
}

function formatCustomerMessage(status) {
  return status === RESERVATION_STATUSES.PENDING_REQUEST
    ? "Your reservation request was received. Our office will review it and contact you using the information you provided."
    : "Reservation updated.";
}

function toReservationResponse(row) {
  return {
    ReservationID: row.reservationid,
    RequestNumber: formatReservationRequestNumber(row.reservationid),
    VehicleID: row.vehicleid,
    CustomerName: row.customername,
    CustomerEmail: row.customeremail,
    CustomerPhone: row.customerphone,
    CustomerNotes: row.customernotes || "",
    PickupAt: row.pickupat,
    ReturnAt: row.returnat,
    Status: normalizeReservationStatus(row.status) || row.status,
    StatusVersion: Number(row.statusversion || 1),
    EstimatedTotal: row.estimatedtotal,
    DepositAmount: row.depositamount,
    PaymentMethod: "PAY_AT_PICKUP",
    PaymentStatus: "UNPAID",
    AmountDue: row.estimatedtotal,
    DepositDue: row.depositamount,
    CreatedAt: row.createdat,
    UpdatedAt: row.updatedat,
    Make: row.make,
    Model: row.model,
    Year: row.year,
    PlateNumber: row.platenumber,
    LocationName: row.locationname
  };
}

async function readTransitionHistory(database, reservationId) {
  const result = await database.query(
    `SELECT id, from_status, to_status, status_version, operation, reason, created_at
     FROM reservation_status_history WHERE reservation_id = $1 ORDER BY created_at ASC, id ASC`,
    [reservationId]
  );
  return result.rows.map((row) => ({
    FromStatus: row.from_status, ToStatus: row.to_status, StatusVersion: Number(row.status_version),
    Operation: row.operation, Reason: row.reason || "", CreatedAt: row.created_at
  }));
}

function creationResponse(row, accessToken = null) {
  return {
    message: `${formatCustomerMessage(RESERVATION_STATUSES.PENDING_REQUEST)} Payment and any required deposit are collected at pickup.`,
    reservation: {
      ReservationID: row.reservationid,
      requestNumber: formatReservationRequestNumber(row.reservationid),
      VehicleID: Number(row.vehicleid),
      Status: RESERVATION_STATUSES.PENDING_REQUEST,
      EstimatedTotal: money(row.estimatedtotal),
      DepositAmount: money(row.depositamount),
      payment: {
        method: "PAY_AT_PICKUP",
        status: "UNPAID",
        amountDue: money(row.estimatedtotal),
        depositDue: money(row.depositamount),
        message: "Payment and any required deposit are collected at pickup."
      },
      ...(accessToken ? { accessToken } : {}),
      NotificationStatus: "queued"
    }
  };
}

async function readReservation(database, reservationId, client = database, lock = false) {
  const result = await client.query(
    `SELECT r.*, v.make, v.model, v.year, v.platenumber, v.locationname
     FROM reservationsmvp r
     JOIN vehicles v ON r.vehicleid = v.vehicleid
     WHERE r.reservationid = $1${lock ? " FOR UPDATE OF r" : ""}`,
    [reservationId]
  );
  return result.rows[0] || null;
}

async function readReservationByIdempotency(database, keyHash) {
  const result = await database.query(
    `SELECT r.*, v.make, v.model, v.year, v.platenumber, v.locationname
     FROM reservationsmvp r
     JOIN vehicles v ON r.vehicleid = v.vehicleid
     WHERE r.idempotency_key_hash = $1
     LIMIT 1`,
    [keyHash]
  );
  return result.rows[0] || null;
}

async function hasOverlap(client, reservation, excludeReservationId = null) {
  const values = [reservation.vehicleid, reservation.returnat, reservation.pickupat, BLOCKING_RESERVATION_STATUSES];
  let sql = `
    SELECT reservationid
    FROM reservationsmvp
    WHERE vehicleid = $1
      AND pickupat < $2
      AND returnat > $3
      AND UPPER(status) = ANY($4::text[])
  `;
  if (excludeReservationId) {
    values.push(excludeReservationId);
    sql += " AND reservationid <> $5";
  }
  const result = await client.query(sql, values);
  return result.rowCount > 0;
}

async function lockVehicle(client, vehicleId) {
  const result = await client.query("SELECT * FROM vehicles WHERE vehicleid = $1 FOR UPDATE", [vehicleId]);
  return result.rows[0] || null;
}

function validationFailure(res, validation) {
  return res.status(400).json({ error: validation.error.message, code: validation.error.code });
}

function idempotencyConflictResponse(res) {
  return res.status(409).json({ error: "Idempotency-Key was already used for a different reservation request", code: "IDEMPOTENCY_CONFLICT" });
}

function replayResponse(res, reservation, accessToken = null) {
  res.set("Idempotent-Replay", "true");
  return res.status(201).json(creationResponse(reservation, accessToken));
}

function createReservationsRouter({ database = defaultDatabase } = {}) {
  const router = express.Router();

  router.get("/", requireAdminSession, async (_req, res) => {
    try {
      const result = await database.query(
        `SELECT r.*, v.make, v.model, v.year, v.platenumber, v.locationname
         FROM reservationsmvp r
         JOIN vehicles v ON r.vehicleid = v.vehicleid
         ORDER BY r.createdat DESC`
      );
      const reservations = await Promise.all(result.rows.map(async (row) => ({
        ...toReservationResponse(row), TransitionHistory: await readTransitionHistory(database, row.reservationid), Inspections: await readInspections(database, row.reservationid), Notifications: await readNotificationHistory(database, row.reservationid), Counter: await counterService.readCounter(database, row.reservationid)
      })));
      res.json({ reservations });
    } catch (error) {
      logFailure("reservations.list", error);
      res.status(500).json({ error: "Failed to load reservations" });
    }
  });

  router.post("/", async (req, res) => {
    const keyValidation = validateIdempotencyKey(req.get("Idempotency-Key"));
    if (keyValidation.error) return validationFailure(res, keyValidation);
    const requestValidation = validateReservationRequest(req.body);
    if (requestValidation.error) return validationFailure(res, requestValidation);

    const request = requestValidation.value;
    const keyHash = sha256(keyValidation.value);
    const requestHash = reservationRequestHash(request);
    const suppliedAccessToken = req.get("X-Reservation-Access-Token");
    if (suppliedAccessToken && !validToken(suppliedAccessToken)) {
      return res.status(400).json({ error: "Reservation access credential is invalid", code: "INVALID_RESERVATION_ACCESS_TOKEN" });
    }
    let client;
    let transactionStarted = false;

    try {
      const existing = await readReservationByIdempotency(database, keyHash);
      if (existing) {
        if (existing.idempotency_request_hash !== requestHash) return idempotencyConflictResponse(res);
        if (suppliedAccessToken && existing.customer_access_token_hash && tokenHash(suppliedAccessToken) !== existing.customer_access_token_hash) {
          return res.status(409).json({ error: "Idempotency-Key was already used with a different reservation access credential", code: "IDEMPOTENCY_CONFLICT" });
        }
        return replayResponse(res, existing, suppliedAccessToken || null);
      }

      client = await database.connect();
      await client.query("BEGIN");
      transactionStarted = true;
      const vehicle = await lockVehicle(client, request.vehicleId);
      if (!vehicle) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.status(404).json({ error: "Vehicle not found" });
      }
      if (!isOperationallyAvailable(vehicle.status)) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.status(409).json({ error: "Vehicle is not accepting reservations" });
      }
      if (await hasOverlap(client, { vehicleid: vehicle.vehicleid, pickupat: request.pickupAt, returnat: request.returnAt })) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.status(409).json({ error: "Vehicle is not available for the requested dates" });
      }

      const estimatedTotal = money(vehicle.dailyrate) * calculateDays(request.pickupAt, request.returnAt);
      const depositAmount = money(vehicle.depositamount);
      const accessToken = suppliedAccessToken || issueToken();
      const insertResult = await client.query(
        `INSERT INTO reservationsmvp
          (vehicleid, customername, customeremail, customerphone, customernotes, pickupat, returnat, status,
           estimatedtotal, depositamount, idempotency_key_hash, idempotency_request_hash, customer_access_token_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING reservationid`,
        [
          request.vehicleId,
          request.customerName,
          request.customerEmail,
          request.customerPhone || null,
          request.customerNotes || null,
          request.pickupAt,
          request.returnAt,
          RESERVATION_STATUSES.PENDING_REQUEST,
          estimatedTotal,
          depositAmount,
          keyHash,
          requestHash,
          tokenHash(accessToken)
        ]
      );
      const reservation = await readReservation(database, insertResult.rows[0].reservationid, client);
      await enqueueReservationCreated(client, reservation, { manageUrl: suppliedAccessToken ? manageUrlFor(accessToken) : null });
      await client.query("COMMIT");
      transactionStarted = false;
      client.release();
      client = null;

      // Browser customers supply their own 256-bit access credential so an
      // idempotent retry can safely receive the exact same private token.
      // Legacy callers still receive the prior reservation response shape.
      return res.status(201).json(creationResponse(reservation, suppliedAccessToken ? accessToken : null));
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      if (client) {
        client.release();
        client = null;
      }
      if (isIdempotencyConflict(error)) {
        try {
          const existing = await readReservationByIdempotency(database, keyHash);
          if (existing?.idempotency_request_hash === requestHash) {
            if (suppliedAccessToken && existing.customer_access_token_hash && tokenHash(suppliedAccessToken) !== existing.customer_access_token_hash) {
              return res.status(409).json({ error: "Idempotency-Key was already used with a different reservation access credential", code: "IDEMPOTENCY_CONFLICT" });
            }
            return replayResponse(res, existing, suppliedAccessToken || null);
          }
          return idempotencyConflictResponse(res);
        } catch (lookupError) {
          logFailure("reservations.idempotency.lookup", lookupError);
        }
      }
      logFailure("reservations.create", error);
      return res.status(500).json({ error: "Failed to create reservation" });
    } finally {
      if (client) client.release();
    }
  });

  router.get("/:reservationId/history", requireAdminSession, async (req, res) => {
    try { return res.json({ history: await readTransitionHistory(database, req.params.reservationId) }); }
    catch (error) { logFailure("reservations.history", error); return res.status(500).json({ error: "Failed to load reservation history" }); }
  });

  router.get("/:reservationId/inspections", requireAdminSession, async (req, res) => {
    try { return res.json({ inspections: await readInspections(database, req.params.reservationId) }); }
    catch (error) { logFailure("reservations.inspections.read", error); return res.status(500).json({ error: "Failed to load inspections" }); }
  });

  router.post("/:reservationId/inspections/:inspectionType", requireAdminSession, requireRole("OWNER", "STAFF"), requireCsrf, async (req, res) => {
    const typeMap = { pickup: "PICKUP", return: "RETURN" };
    const inspectionType = typeMap[String(req.params.inspectionType || "").toLowerCase()];
    if (!inspectionType) return res.status(404).json({ error: "Inspection route was not found" });
    try {
      const inspection = await submitInspection({ database, reservationId: req.params.reservationId, inspectionType, input: req.body, actor: req.admin });
      return res.status(201).json({ inspection });
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.statusCode)) return res.status(error.statusCode).json({ error: error.statusCode === 409 ? "Inspection state conflict" : error.message, ...(error.code ? { code: error.code } : {}) });
      logFailure("reservations.inspections.submit", error);
      return res.status(500).json({ error: "Failed to complete inspection" });
    }
  });

  router.post("/:reservationId/operations/:operation", requireAdminSession, requireRole("OWNER", "STAFF"), requireCsrf, async (req, res) => {
    try {
      const result = await transitionReservation({ database, reservationId: req.params.reservationId, operation: req.params.operation, expectedStatusVersion: req.body?.expectedStatusVersion, reason: req.body?.reason, actor: req.admin });
      const reservation = toReservationResponse(result.reservation);
      reservation.TransitionHistory = await readTransitionHistory(database, req.params.reservationId);
      reservation.Notifications = await readNotificationHistory(database, req.params.reservationId);
      reservation.Inspections = await readInspections(database, req.params.reservationId);
      reservation.Counter = await counterService.readCounter(database, Number(req.params.reservationId));
      return res.json({ message: "Reservation lifecycle updated", reservation });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 403 || error.statusCode === 404) return res.status(error.statusCode).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      if (error.statusCode === 409 || isAvailabilityConflict(error)) return res.status(409).json({ error: ["COUNTER_CHECKS_REQUIRED", "BALANCE_DUE"].includes(error.code) ? error.message : "Reservation state conflict", code: isAvailabilityConflict(error) ? CONFLICT_CODE : (error.code || CONFLICT_CODE) });
      logFailure("reservations.operation", error);
      return res.status(500).json({ error: "Failed to update reservation lifecycle" });
    }
  });

  function counterFailure(res, error, label) {
    if ([400, 403, 404, 409].includes(error.statusCode)) return res.status(error.statusCode).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    logFailure(label, error);
    return res.status(500).json({ error: "The counter record could not be updated" });
  }

  router.get("/:reservationId/counter", requireAdminSession, async (req, res) => {
    try { return res.json({ counter: await counterService.readCounter(database, Number(req.params.reservationId)) }); }
    catch (error) { return counterFailure(res, error, "reservations.counter.read"); }
  });

  router.patch("/:reservationId/counter/checks", requireAdminSession, requireRole("OWNER", "STAFF"), requireCsrf, async (req, res) => {
    try { return res.json({ counter: await counterService.updateChecks(database, { reservationId: req.params.reservationId, checks: req.body?.checks || {}, note: req.body?.note, actor: req.admin }) }); }
    catch (error) { return counterFailure(res, error, "reservations.counter.checks"); }
  });

  router.post("/:reservationId/payments", requireAdminSession, requireRole("OWNER", "STAFF"), requireCsrf, async (req, res) => {
    try { return res.status(201).json({ counter: await counterService.recordPayment(database, { reservationId: req.params.reservationId, ...req.body, actor: req.admin }) }); }
    catch (error) { return counterFailure(res, error, "reservations.payments.record"); }
  });

  router.post("/:reservationId/charges", requireAdminSession, requireRole("OWNER", "STAFF"), requireCsrf, async (req, res) => {
    try { return res.status(201).json({ counter: await counterService.addCharge(database, { reservationId: req.params.reservationId, description: req.body?.description, amountCents: req.body?.amountCents, actor: req.admin }) }); }
    catch (error) { return counterFailure(res, error, "reservations.charges.add"); }
  });

  return router;
}

const router = createReservationsRouter();
module.exports = router;
module.exports.createReservationsRouter = createReservationsRouter;
module.exports.RESERVATION_STATUSES = RESERVATION_STATUSES;
module.exports.isAvailabilityConflict = isAvailabilityConflict;
module.exports.isIdempotencyConflict = isIdempotencyConflict;
module.exports.readTransitionHistory = readTransitionHistory;
module.exports.calculateDays = calculateDays;
