const express = require("express");
const db = require("../db/connection");
const { publicVehicle, normalizePhoto } = require("../utils/vehicleMapper");
const { logFailure } = require("../utils/safeLog");
const { BLOCKING_RESERVATION_STATUSES, parseAvailabilityInterval } = require("../utils/reservationPolicy");

const router = express.Router();

function availabilityClause(params, interval) {
  if (!interval) return "";
  params.push(interval.pickupAt, interval.returnAt, BLOCKING_RESERVATION_STATUSES);
  return `
    AND NOT EXISTS (
      SELECT 1
      FROM reservationsmvp reservation
      WHERE reservation.vehicleid = vehicles.vehicleid
        AND reservation.pickupat < $2::timestamptz
        AND reservation.returnat > $1::timestamptz
        AND UPPER(reservation.status) = ANY($3::text[])
    )`;
}

async function photosByVehicle(vehicleIds) {
  if (vehicleIds.length === 0) return new Map();

  const result = await db.query(
    "SELECT * FROM vehiclephotos WHERE vehicleid = ANY($1::integer[]) ORDER BY isprimary DESC, sortorder ASC, photoid ASC",
    [vehicleIds]
  );

  const map = new Map();
  result.rows.forEach((row) => {
    const photos = map.get(row.vehicleid) || [];
    photos.push(normalizePhoto(row));
    map.set(row.vehicleid, photos);
  });

  return map;
}

router.get("/vehicles", async (req, res) => {
  const { interval, error: intervalError } = parseAvailabilityInterval(req.query);
  if (intervalError) return res.status(400).json({ error: intervalError });

  try {
    const params = [];
    let query = "SELECT * FROM vehicles WHERE status = 'READY'";
    query += availabilityClause(params, interval);

    query += " ORDER BY dailyrate ASC, year DESC";
    const result = await db.query(
      query,
      params
    );
    const photos = await photosByVehicle(result.rows.map((vehicle) => vehicle.vehicleid));

    res.json({
      vehicles: result.rows.map((vehicle) => publicVehicle(vehicle, photos.get(vehicle.vehicleid) || []))
    });
  } catch (error) {
    logFailure("public vehicles.list", error);
    res.status(500).json({ error: "Failed to load public vehicles" });
  }
});

router.get("/vehicles/:vehicleId", async (req, res) => {
  const { interval, error: intervalError } = parseAvailabilityInterval(req.query);
  if (intervalError) return res.status(400).json({ error: intervalError });
  try {
    const params = [req.params.vehicleId];
    let query = "SELECT * FROM vehicles WHERE vehicleid = $1 AND status = 'READY'";
    if (interval) {
      params.push(interval.pickupAt, interval.returnAt, BLOCKING_RESERVATION_STATUSES);
      query += `
        AND NOT EXISTS (
          SELECT 1 FROM reservationsmvp reservation
          WHERE reservation.vehicleid = vehicles.vehicleid
            AND reservation.pickupat < $3::timestamptz
            AND reservation.returnat > $2::timestamptz
            AND UPPER(reservation.status) = ANY($4::text[])
        )`;
    }
    const result = await db.query(
      query,
      params
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Vehicle not found or not available" });
    }

    const vehicle = result.rows[0];
    const photos = await photosByVehicle([vehicle.vehicleid]);
    res.json({ vehicle: publicVehicle(vehicle, photos.get(vehicle.vehicleid) || []) });
  } catch (error) {
    logFailure("public vehicles.read", error);
    res.status(500).json({ error: "Failed to load public vehicle" });
  }
});

module.exports = router;
module.exports.availabilityClause = availabilityClause;
