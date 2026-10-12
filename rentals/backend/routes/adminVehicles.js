const express = require("express");
const fs = require("fs");
const multer = require("multer");

const db = require("../db/connection");
const { requireAdminSession, requireCsrf, requireRole } = require("../middleware/requireAdmin");
const { logFailure } = require("../utils/safeLog");
const { writeAudit } = require("../services/adminAuthService");
const { moduleEnv } = require("../config/env");
const {
  IMAGE_UPLOAD_LIMITS,
  removeStoredImages,
  storeValidatedImages,
  uploadError,
  validateImageFiles,
  vehiclePhotoPath,
  vehicleUploadDirectory,
  vehiclePhotoStorageKey
} = require("../utils/imageUpload");
const {
  money,
  integer,
  normalizeStatus,
  normalizeVehicle,
  normalizePhoto
} = require("../utils/vehicleMapper");

const router = express.Router();
const audit = (req, action, entityId, client = db) => writeAudit(client, req.admin.id, action, "VEHICLE", entityId);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_UPLOAD_LIMITS.maxBytes, files: IMAGE_UPLOAD_LIMITS.maxFiles },
  fileFilter: (_req, file, callback) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return callback(uploadError("UNSUPPORTED_IMAGE_TYPE", "Only JPEG, PNG, and WebP images are allowed"));
    }
    callback(null, true);
  }
});

function configuredVehicleUploadDirectory(req) {
  return req.app?.locals?.driveOpsConfig?.vehicleUploadDirectory || vehicleUploadDirectory();
}

function publicImageUrl(req, filename) {
  const base = (req.app?.locals?.driveOpsConfig?.publicBaseUrl || moduleEnv().PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return `${base}/uploads/vehicles/${filename}`;
}

async function deleteStoredVehiclePhoto(storageKey, uploadDirectory) {
  let destination;
  try {
    destination = vehiclePhotoPath(storageKey, uploadDirectory);
  } catch (_error) {
    return false;
  }
  await fs.promises.unlink(destination).catch(() => undefined);
  return true;
}

function bodyValue(body, ...keys) {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== "") return body[key];
  }
  return null;
}

function parseVehicleBody(body) {
  const make = bodyValue(body, "make", "Make");
  const model = bodyValue(body, "model", "Model");
  const year = integer(bodyValue(body, "year", "Year"), null);
  const category = bodyValue(body, "category", "Category") || "Sedan";
  const dailyRate = money(bodyValue(body, "dailyRate", "DailyRate", "daily_price", "price"));

  if (!make || !model || !year || !dailyRate) {
    const error = new Error("Make, model, year, and daily rate are required");
    error.statusCode = 400;
    throw error;
  }

  return {
    VIN: bodyValue(body, "vin", "VIN") || null,
    PlateNumber: bodyValue(body, "plateNumber", "PlateNumber", "plate") || null,
    Make: make,
    Model: model,
    Year: year,
    Color: bodyValue(body, "color", "Color") || null,
    Category: category,
    Seats: integer(bodyValue(body, "seats", "Seats"), 5),
    Transmission: bodyValue(body, "transmission", "Transmission") || "Automatic",
    FuelType: bodyValue(body, "fuelType", "FuelType") || "Gasoline",
    Mileage: integer(bodyValue(body, "mileage", "Mileage"), 0),
    DailyRate: dailyRate,
    DepositAmount: money(bodyValue(body, "depositAmount", "DepositAmount", "deposit")),
    LocationName:
      bodyValue(body, "locationName", "LocationName", "location") || "Trucker Heaven Rentals - Mt. Juliet",
    Status: normalizeStatus(bodyValue(body, "status", "Status")),
    Notes: bodyValue(body, "notes", "Notes") || null
  };
}

function vehicleMutationError(error) {
  if (error?.code !== "23505") return null;
  const constraint = String(error.constraint || "").toLowerCase();
  if (constraint.includes("platenumber")) {
    return { statusCode: 409, code: "DUPLICATE_PLATE_NUMBER", message: "A vehicle with this plate number already exists" };
  }
  if (constraint.includes("vin")) {
    return { statusCode: 409, code: "DUPLICATE_VIN", message: "A vehicle with this VIN already exists" };
  }
  return { statusCode: 409, code: "DUPLICATE_VEHICLE_IDENTIFIER", message: "A vehicle with these identifiers already exists" };
}

function sendVehicleMutationError(res, error, fallback) {
  const conflict = vehicleMutationError(error);
  if (conflict) return res.status(conflict.statusCode).json({ error: conflict.message, code: conflict.code });
  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({
    error: statusCode < 500 ? error.message : fallback,
    ...(statusCode < 500 && error.code ? { code: error.code } : {})
  });
}

async function getPhotosForVehicles(vehicleIds) {
  if (vehicleIds.length === 0) return new Map();

  const result = await db.query(
    "SELECT * FROM vehiclephotos WHERE vehicleid = ANY($1::integer[]) ORDER BY isprimary DESC, sortorder ASC, photoid ASC",
    [vehicleIds]
  );
  const grouped = new Map();

  for (const row of result.rows) {
    const photos = grouped.get(row.vehicleid) || [];
    photos.push(normalizePhoto(row));
    grouped.set(row.vehicleid, photos);
  }

  return grouped;
}

async function readVehicle(vehicleId) {
  const vehicleResult = await db.query("SELECT * FROM vehicles WHERE vehicleid = $1", [vehicleId]);
  if (vehicleResult.rowCount === 0) return null;

  const photoResult = await db.query(
    "SELECT * FROM vehiclephotos WHERE vehicleid = $1 ORDER BY isprimary DESC, sortorder ASC, photoid ASC",
    [vehicleId]
  );
  return normalizeVehicle(vehicleResult.rows[0], photoResult.rows.map(normalizePhoto));
}

async function saveUploadedPhotos(req, client, vehicleId, files, makeFirstPrimary = false) {
  if (!files || files.length === 0) return;

  if (makeFirstPrimary) {
    await client.query("UPDATE vehiclephotos SET isprimary = FALSE WHERE vehicleid = $1", [vehicleId]);
  }

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    await client.query(
      `INSERT INTO vehiclephotos
        (vehicleid, imageurl, storagekey, phototype, isprimary, sortorder)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        vehicleId,
        publicImageUrl(req, file.filename),
        vehiclePhotoStorageKey(file.filename),
        "PUBLIC",
        makeFirstPrimary && index === 0,
        index
      ]
    );
  }
}

router.get("/", requireAdminSession, async (_req, res) => {
  try {
    const result = await db.query("SELECT * FROM vehicles ORDER BY createdat DESC, vehicleid DESC");
    const photoMap = await getPhotosForVehicles(result.rows.map((vehicle) => vehicle.vehicleid));
    res.json({
      vehicles: result.rows.map((vehicle) => normalizeVehicle(vehicle, photoMap.get(vehicle.vehicleid) || []))
    });
  } catch (error) {
    logFailure("admin vehicles.list", error);
    res.status(500).json({ error: "Failed to load vehicles" });
  }
});

router.get("/:vehicleId", requireAdminSession, async (req, res) => {
  try {
    const vehicle = await readVehicle(req.params.vehicleId);
    if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
    res.json({ vehicle });
  } catch (error) {
    logFailure("admin vehicles.read", error);
    res.status(500).json({ error: "Failed to load vehicle" });
  }
});

router.post("/", requireAdminSession, requireRole("OWNER"), requireCsrf, upload.array("photos", 10), async (req, res) => {
  const client = await db.connect();
  let transactionStarted = false;
  let committed = false;
  let storedFiles = [];

  try {
    const vehicle = parseVehicleBody(req.body);
    validateImageFiles(req.files || []);
    await client.query("BEGIN");
    transactionStarted = true;
    storedFiles = await storeValidatedImages(req.files || [], configuredVehicleUploadDirectory(req));
    const result = await client.query(
      `INSERT INTO vehicles
        (vin, platenumber, make, model, year, color, category, seats, transmission, fueltype,
         mileage, dailyrate, depositamount, locationname, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING vehicleid`,
      [
        vehicle.VIN,
        vehicle.PlateNumber,
        vehicle.Make,
        vehicle.Model,
        vehicle.Year,
        vehicle.Color,
        vehicle.Category,
        vehicle.Seats,
        vehicle.Transmission,
        vehicle.FuelType,
        vehicle.Mileage,
        vehicle.DailyRate,
        vehicle.DepositAmount,
        vehicle.LocationName,
        vehicle.Status,
        vehicle.Notes
      ]
    );
    const vehicleId = result.rows[0].vehicleid;
    await saveUploadedPhotos(req, client, vehicleId, storedFiles, true);
    await audit(req, "VEHICLE_CREATE", vehicleId, client);
    await client.query("COMMIT");
    transactionStarted = false;
    committed = true;

    res.status(201).json({ message: "Vehicle created", vehicle: await readVehicle(vehicleId) });
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    if (!committed) await removeStoredImages(storedFiles);
    logFailure("admin vehicles.create", error);
    sendVehicleMutationError(res, error, "Failed to create vehicle");
  } finally {
    client.release();
  }
});

router.patch("/:vehicleId", requireAdminSession, requireRole("OWNER"), requireCsrf, async (req, res) => {
  try {
    const vehicle = parseVehicleBody(req.body);
    const result = await db.query(
      `UPDATE vehicles
       SET vin = $1, platenumber = $2, make = $3, model = $4, year = $5, color = $6, category = $7,
           seats = $8, transmission = $9, fueltype = $10, mileage = $11, dailyrate = $12,
           depositamount = $13, locationname = $14, status = $15, notes = $16, updatedat = CURRENT_TIMESTAMP
       WHERE vehicleid = $17`,
      [
        vehicle.VIN,
        vehicle.PlateNumber,
        vehicle.Make,
        vehicle.Model,
        vehicle.Year,
        vehicle.Color,
        vehicle.Category,
        vehicle.Seats,
        vehicle.Transmission,
        vehicle.FuelType,
        vehicle.Mileage,
        vehicle.DailyRate,
        vehicle.DepositAmount,
        vehicle.LocationName,
        vehicle.Status,
        vehicle.Notes,
        req.params.vehicleId
      ]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Vehicle not found" });
    await audit(req, "VEHICLE_UPDATE", req.params.vehicleId);
    res.json({ message: "Vehicle updated", vehicle: await readVehicle(req.params.vehicleId) });
  } catch (error) {
    logFailure("admin vehicles.update", error);
    sendVehicleMutationError(res, error, "Failed to update vehicle");
  }
});

router.patch("/:vehicleId/status", requireAdminSession, requireRole("OWNER"), requireCsrf, async (req, res) => {
  try {
    const result = await db.query(
      "UPDATE vehicles SET status = $1, updatedat = CURRENT_TIMESTAMP WHERE vehicleid = $2",
      [normalizeStatus(req.body.status), req.params.vehicleId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Vehicle not found" });
    await audit(req, "VEHICLE_STATUS_UPDATE", req.params.vehicleId);
    res.json({ message: "Vehicle status updated", vehicle: await readVehicle(req.params.vehicleId) });
  } catch (error) {
    logFailure("admin vehicles.status", error);
    res.status(500).json({ error: "Failed to update vehicle status" });
  }
});

router.delete("/:vehicleId", requireAdminSession, requireRole("OWNER"), requireCsrf, async (req, res) => {
  try {
    const result = await db.query(
      "UPDATE vehicles SET status = 'RETIRED', updatedat = CURRENT_TIMESTAMP WHERE vehicleid = $1",
      [req.params.vehicleId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Vehicle not found" });
    await audit(req, "VEHICLE_DEACTIVATE", req.params.vehicleId);
    res.json({ message: "Vehicle retired" });
  } catch (error) {
    logFailure("admin vehicles.delete", error);
    res.status(500).json({ error: "Failed to retire vehicle" });
  }
});

router.post("/:vehicleId/photos", requireAdminSession, requireRole("OWNER"), requireCsrf, upload.array("photos", 10), async (req, res) => {
  const client = await db.connect();
  let transactionStarted = false;
  let committed = false;
  let storedFiles = [];

  try {
    if (!(await readVehicle(req.params.vehicleId))) return res.status(404).json({ error: "Vehicle not found" });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "At least one photo is required" });
    validateImageFiles(req.files);

    const makePrimary = String(req.body.makePrimary || "false").toLowerCase() === "true";
    await client.query("BEGIN");
    transactionStarted = true;
    storedFiles = await storeValidatedImages(req.files, configuredVehicleUploadDirectory(req));
    await saveUploadedPhotos(req, client, req.params.vehicleId, storedFiles, makePrimary);
    await audit(req, "VEHICLE_PHOTOS_ADD", req.params.vehicleId, client);
    await client.query("COMMIT");
    transactionStarted = false;
    committed = true;

    res.status(201).json({ message: "Photos uploaded", vehicle: await readVehicle(req.params.vehicleId) });
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    if (!committed) await removeStoredImages(storedFiles);
    logFailure("admin vehicles.photos.create", error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ error: statusCode < 500 ? error.message : "Failed to upload photos", ...(error.code ? { code: error.code } : {}) });
  } finally {
    client.release();
  }
});

router.patch("/:vehicleId/photos/:photoId/primary", requireAdminSession, requireRole("OWNER"), requireCsrf, async (req, res) => {
  const client = await db.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("UPDATE vehiclephotos SET isprimary = FALSE WHERE vehicleid = $1", [req.params.vehicleId]);
    const result = await client.query(
      "UPDATE vehiclephotos SET isprimary = TRUE WHERE vehicleid = $1 AND photoid = $2",
      [req.params.vehicleId, req.params.photoId]
    );
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({ error: "Photo not found" });
    }

    await audit(req, "VEHICLE_PHOTO_PRIMARY", req.params.vehicleId, client);
    await client.query("COMMIT");
    transactionStarted = false;
    res.json({ message: "Primary photo updated", vehicle: await readVehicle(req.params.vehicleId) });
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    logFailure("admin vehicles.photos.primary", error);
    res.status(500).json({ error: "Failed to update primary photo" });
  } finally {
    client.release();
  }
});

router.delete("/:vehicleId/photos/:photoId", requireAdminSession, requireRole("OWNER"), requireCsrf, async (req, res) => {
  try {
    const photoResult = await db.query(
      "SELECT * FROM vehiclephotos WHERE vehicleid = $1 AND photoid = $2 LIMIT 1",
      [req.params.vehicleId, req.params.photoId]
    );
    if (photoResult.rowCount === 0) return res.status(404).json({ error: "Photo not found" });

    await db.query("DELETE FROM vehiclephotos WHERE vehicleid = $1 AND photoid = $2", [
      req.params.vehicleId,
      req.params.photoId
    ]);
    await audit(req, "VEHICLE_PHOTO_DELETE", req.params.vehicleId);
    const storageKey = photoResult.rows[0].storagekey;
    await deleteStoredVehiclePhoto(storageKey, configuredVehicleUploadDirectory(req));
    res.json({ message: "Photo deleted", vehicle: await readVehicle(req.params.vehicleId) });
  } catch (error) {
    logFailure("admin vehicles.photos.delete", error);
    res.status(500).json({ error: "Failed to delete photo" });
  }
});

module.exports = router;
module.exports.configuredVehicleUploadDirectory = configuredVehicleUploadDirectory;
module.exports.deleteStoredVehiclePhoto = deleteStoredVehiclePhoto;
module.exports.saveUploadedPhotos = saveUploadedPhotos;
module.exports.vehicleMutationError = vehicleMutationError;
