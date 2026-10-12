const { normalizeOperationalStatus } = require("./reservationPolicy");

function money(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStatus(status) {
  return normalizeOperationalStatus(status);
}

function normalizeVehicle(row, photos = []) {
  const primary = photos.find((photo) => Boolean(photo.isPrimary)) || photos[0] || null;

  return {
    id: row.vehicleid,
    vehicleId: row.vehicleid,
    vin: row.vin,
    plateNumber: row.platenumber,
    make: row.make,
    model: row.model,
    year: integer(row.year),
    color: row.color,
    category: row.category,
    seats: integer(row.seats, 5),
    transmission: row.transmission,
    fuelType: row.fueltype,
    mileage: integer(row.mileage),
    dailyRate: money(row.dailyrate),
    depositAmount: money(row.depositamount),
    locationName: row.locationname,
    status: normalizeStatus(row.status),
    notes: row.notes,
    primaryPhotoUrl: primary ? primary.imageUrl : null,
    photos,
    createdAt: row.createdat,
    updatedAt: row.updatedat
  };
}

// What the public site may show. Never exposes VIN, plate, internal notes or storage paths.
function publicVehicle(row, photos = []) {
  const vehicle = normalizeVehicle(row, photos);
  return {
    id: vehicle.id,
    vehicleId: vehicle.vehicleId,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    color: vehicle.color,
    category: vehicle.category,
    seats: vehicle.seats,
    transmission: vehicle.transmission,
    fuelType: vehicle.fuelType,
    mileage: vehicle.mileage,
    dailyRate: vehicle.dailyRate,
    depositAmount: vehicle.depositAmount,
    locationName: vehicle.locationName,
    status: vehicle.status,
    primaryPhotoUrl: vehicle.primaryPhotoUrl,
    photos: photos.map((photo) => ({ id: photo.id, imageUrl: photo.imageUrl, isPrimary: photo.isPrimary, sortOrder: photo.sortOrder }))
  };
}

function normalizePhoto(row) {
  return {
    id: row.photoid,
    photoId: row.photoid,
    vehicleId: row.vehicleid,
    imageUrl: row.imageurl,
    storageKey: row.storagekey,
    photoType: row.phototype,
    isPrimary: Boolean(row.isprimary),
    sortOrder: integer(row.sortorder),
    createdAt: row.createdat
  };
}

module.exports = {
  money,
  integer,
  normalizeStatus,
  normalizeVehicle,
  publicVehicle,
  normalizePhoto
};
