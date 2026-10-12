const express = require("express");
const db = require("../db/connection");
const { normalizeVehicle, normalizePhoto } = require("../utils/vehicleMapper");
const { logFailure } = require("../utils/safeLog");

const router = express.Router();

async function getPhotos(vehicleIds) {
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

async function listVehicles({ availableOnly = false } = {}) {
  const where = availableOnly ? "WHERE LOWER(status) IN ('available', 'ready')" : "";
  const result = await db.query(`SELECT * FROM vehicles ${where} ORDER BY year DESC, make ASC, model ASC`);
  const photos = await getPhotos(result.rows.map((vehicle) => vehicle.vehicleid));

  return result.rows.map((vehicle) => normalizeVehicle(vehicle, photos.get(vehicle.vehicleid) || []));
}

router.get("/", async (_req, res) => {
  try {
    const vehicles = await listVehicles({ availableOnly: false });
    res.json({ vehicles });
  } catch (error) {
    logFailure("cars.list", error);
    res.status(500).json({ error: "Failed to load cars" });
  }
});

router.get("/available", async (_req, res) => {
  try {
    const vehicles = await listVehicles({ availableOnly: true });
    res.json({ vehicles, cars: vehicles });
  } catch (error) {
    logFailure("cars.available", error);
    res.status(500).json({ error: "Failed to load available cars" });
  }
});

router.get("/:vehicleId", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM vehicles WHERE vehicleid = $1", [req.params.vehicleId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Car not found" });
    }

    const vehicle = result.rows[0];
    const photos = await getPhotos([vehicle.vehicleid]);
    res.json({ vehicle: normalizeVehicle(vehicle, photos.get(vehicle.vehicleid) || []) });
  } catch (error) {
    logFailure("cars.read", error);
    res.status(500).json({ error: "Failed to load car" });
  }
});

module.exports = router;
