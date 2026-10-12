const { writeAudit } = require("./adminAuthService");
const { INSPECTION_TYPES, validateInspection } = require("../utils/rentalInspectionPolicy");
const { RESERVATION_STATUSES, normalizeReservationStatus } = require("../utils/reservationPolicy");

const INSPECTION_ALREADY_COMPLETED = "INSPECTION_ALREADY_COMPLETED";
const INSPECTION_STATE_CONFLICT = "INSPECTION_STATE_CONFLICT";

function conflict(code) {
  const error = new Error("Inspection state conflict");
  error.statusCode = 409;
  error.code = code;
  return error;
}

function expectedStatus(type) {
  return type === INSPECTION_TYPES.PICKUP ? RESERVATION_STATUSES.READY_FOR_PICKUP : RESERVATION_STATUSES.RETURNED_PENDING_INSPECTION;
}

function inspectionRow(row) {
  return {
    id: row.id, reservationId: row.reservation_id, vehicleId: row.vehicle_id, inspectionType: row.inspection_type,
    odometer: Number(row.odometer), fuelLevelPercent: Number(row.fuel_level_percent), damageObserved: row.damage_observed,
    damageNotes: row.damage_notes || "", cleanlinessNotes: row.cleanliness_notes || "", keysCount: Number(row.keys_count),
    allExpectedKeysReturned: row.all_expected_keys_returned, accessoriesReturned: row.accessories_returned,
    accessoriesNotes: row.accessories_notes || "", completedBy: row.completed_by_email || row.completed_by_admin_user_id,
    completedAt: row.completed_at, createdAt: row.created_at
  };
}

async function readInspections(database, reservationId) {
  const result = await database.query(
    `SELECT i.*, u.email AS completed_by_email FROM rental_inspections i
     JOIN admin_users u ON u.id = i.completed_by_admin_user_id
     WHERE i.reservation_id = $1 ORDER BY i.completed_at, i.id`, [reservationId]
  );
  return result.rows.map(inspectionRow);
}

async function submitInspection({ database, reservationId, inspectionType, input, actor }) {
  if (!actor || !["OWNER", "STAFF"].includes(actor.role)) {
    const error = new Error("You are not authorized to perform this action"); error.statusCode = 403; throw error;
  }
  const type = String(inspectionType || "").toUpperCase();
  if (!Object.values(INSPECTION_TYPES).includes(type)) { const error = new Error("Inspection route was not found"); error.statusCode = 404; throw error; }
  const values = validateInspection(input, type);
  const client = await database.connect();
  let begun = false;
  try {
    await client.query("BEGIN"); begun = true;
    const reservationResult = await client.query("SELECT * FROM reservationsmvp WHERE reservationid = $1 FOR UPDATE", [reservationId]);
    const reservation = reservationResult.rows[0];
    if (!reservation) { const error = new Error("Reservation not found"); error.statusCode = 404; throw error; }
    if (normalizeReservationStatus(reservation.status) !== expectedStatus(type)) throw conflict(INSPECTION_STATE_CONFLICT);
    const vehicleResult = await client.query("SELECT vehicleid, mileage FROM vehicles WHERE vehicleid = $1 FOR UPDATE", [reservation.vehicleid]);
    const vehicle = vehicleResult.rows[0];
    if (!vehicle) throw conflict(INSPECTION_STATE_CONFLICT);
    const prior = await client.query("SELECT id FROM rental_inspections WHERE reservation_id = $1 AND inspection_type = $2", [reservationId, type]);
    if (prior.rowCount) throw conflict(INSPECTION_ALREADY_COMPLETED);
    if (values.odometer < Number(vehicle.mileage)) { const error = new Error("Inspection odometer conflicts with vehicle records"); error.statusCode = 400; error.code = "ODOMETER_BELOW_VEHICLE"; throw error; }
    if (type === INSPECTION_TYPES.RETURN) {
      const pickup = await client.query("SELECT odometer FROM rental_inspections WHERE reservation_id = $1 AND inspection_type = 'PICKUP'", [reservationId]);
      if (!pickup.rows[0] || values.odometer < Number(pickup.rows[0].odometer)) { const error = new Error("Return odometer conflicts with pickup evidence"); error.statusCode = 400; error.code = "RETURN_ODOMETER_BELOW_PICKUP"; throw error; }
    }
    const inserted = await client.query(
      `INSERT INTO rental_inspections (reservation_id, vehicle_id, inspection_type, odometer, fuel_level_percent, damage_observed, damage_notes, cleanliness_notes, keys_count, all_expected_keys_returned, accessories_returned, accessories_notes, completed_by_admin_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [reservationId, reservation.vehicleid, type, values.odometer, values.fuelLevelPercent, values.damageObserved, values.damageNotes, values.cleanlinessNotes, values.keysCount, values.allExpectedKeysReturned, values.accessoriesReturned, values.accessoriesNotes, actor.id]
    );
    await client.query("UPDATE vehicles SET mileage = $1, updatedat = CURRENT_TIMESTAMP WHERE vehicleid = $2", [values.odometer, reservation.vehicleid]);
    await writeAudit(client, actor.id, "RENTAL_INSPECTION_COMPLETED", "RENTAL_INSPECTION", inserted.rows[0].id, { reservationId: Number(reservationId), inspectionType: type, odometer: values.odometer });
    await client.query("COMMIT"); begun = false;
    return inspectionRow({ ...inserted.rows[0], completed_by_email: actor.email });
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

module.exports = { INSPECTION_ALREADY_COMPLETED, INSPECTION_STATE_CONFLICT, inspectionRow, readInspections, submitInspection };
