const { writeAudit } = require("./adminAuthService");
const { enqueueLifecycleNotification } = require("./notificationOutboxService");
const { assertReadyForCheckout, assertSettled } = require("./rentalCounterService");
const {
  RESERVATION_OPERATIONS,
  RESERVATION_STATUSES,
  isAllowedReservationTransition,
  isOperationallyAvailable,
  normalizeReservationStatus
} = require("../utils/reservationPolicy");

const CONFLICT_CODE = "RESERVATION_STATE_CONFLICT";

function workflowConflict(message = "Reservation state changed. Refresh and try an allowed next action.") {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = CONFLICT_CODE;
  return error;
}

function validateReason(value, operation) {
  if (value === undefined || value === null || value === "") return null;
  if (!RESERVATION_OPERATIONS[operation]?.allowsReason || typeof value !== "string" || value.length > 500 || /[\u0000-\u001F\u007F]/.test(value)) {
    const error = new Error("Reason is invalid");
    error.statusCode = 400;
    error.code = "INVALID_TRANSITION_REASON";
    throw error;
  }
  return value;
}

async function transitionReservation({ database, reservationId, operation, expectedStatusVersion, reason: requestedReason, actor }) {
  const operationName = String(operation || "").trim().toUpperCase();
  const definition = RESERVATION_OPERATIONS[operationName];
  if (!definition) {
    const error = new Error("Unknown reservation operation");
    error.statusCode = 404;
    throw error;
  }
  if (!definition.roles.includes(actor?.role)) {
    const error = new Error("You are not authorized to perform this action");
    error.statusCode = 403;
    throw error;
  }
  const version = Number(expectedStatusVersion);
  if (!Number.isInteger(version) || version < 1) {
    const error = new Error("expectedStatusVersion must be a positive integer");
    error.statusCode = 400;
    error.code = "INVALID_STATUS_VERSION";
    throw error;
  }
  const reason = validateReason(requestedReason, operationName);
  const client = await database.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const result = await client.query("SELECT r.*, v.make, v.model, v.year, v.platenumber, v.locationname FROM reservationsmvp r JOIN vehicles v ON v.vehicleid = r.vehicleid WHERE r.reservationid = $1 FOR UPDATE OF r", [reservationId]);
    const reservation = result.rows[0];
    if (!reservation) {
      const error = new Error("Reservation not found"); error.statusCode = 404; throw error;
    }
    const current = normalizeReservationStatus(reservation.status);
    if (Number(reservation.statusversion) !== version || current === definition.target || !isAllowedReservationTransition(current, definition.target)) throw workflowConflict();
    if (definition.target === RESERVATION_STATUSES.CONFIRMED) {
      const vehicle = await client.query("SELECT status FROM vehicles WHERE vehicleid = $1 FOR UPDATE", [reservation.vehicleid]);
      if (!vehicle.rows[0] || !isOperationallyAvailable(vehicle.rows[0].status)) throw workflowConflict("Vehicle is not operationally ready to confirm this reservation");
    }
    const requiredInspection = definition.target === RESERVATION_STATUSES.CHECKED_OUT ? "PICKUP"
      : definition.target === RESERVATION_STATUSES.COMPLETED ? "RETURN" : null;
    // Paperwork is handled at the counter: staff confirm license, insurance and the signed agreement.
    if (definition.target === RESERVATION_STATUSES.CHECKED_OUT) await assertReadyForCheckout(client, reservationId);
    if (requiredInspection) {
      const inspection = await client.query(
        "SELECT id FROM rental_inspections WHERE reservation_id = $1 AND inspection_type = $2",
        [reservationId, requiredInspection]
      );
      if (!inspection.rowCount) {
        const error = workflowConflict();
        error.code = requiredInspection === "PICKUP" ? "PICKUP_INSPECTION_REQUIRED" : "RETURN_INSPECTION_REQUIRED";
        throw error;
      }
    }
    // A rental is only completed once the balance is collected.
    if (definition.target === RESERVATION_STATUSES.COMPLETED) await assertSettled(client, reservationId);
    const updated = await client.query(
      "UPDATE reservationsmvp SET status = $1, statusversion = statusversion + 1, updatedat = CURRENT_TIMESTAMP WHERE reservationid = $2 AND statusversion = $3 RETURNING *",
      [definition.target, reservationId, version]
    );
    if (updated.rowCount !== 1) throw workflowConflict();
    const next = updated.rows[0];
    await client.query(
      "INSERT INTO reservation_status_history (reservation_id, from_status, to_status, status_version, actor_admin_user_id, operation, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [reservationId, current, definition.target, next.statusversion, actor.id, operationName, reason]
    );
    await writeAudit(client, actor.id, "RESERVATION_LIFECYCLE_TRANSITION", "RESERVATION", reservationId, { operation: operationName, fromStatus: current, toStatus: definition.target, statusVersion: next.statusversion });
    await enqueueLifecycleNotification(client, { ...reservation, ...next, reservationid: reservationId }, operationName);
    await client.query("COMMIT");
    begun = false;
    return { reservation: { ...reservation, ...next, status: definition.target }, operation: operationName };
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

module.exports = { CONFLICT_CODE, transitionReservation, validateReason, workflowConflict };
