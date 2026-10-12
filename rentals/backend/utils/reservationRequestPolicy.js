const crypto = require("crypto");
const { parseTimestamp } = require("./reservationPolicy");

const RESERVATION_REQUEST_LIMITS = Object.freeze({
  customerName: 160,
  customerEmail: 160,
  customerPhone: 40,
  customerNotes: 1000,
  idempotencyKeyMin: 16,
  idempotencyKeyMax: 128
});

let configuredMaxRentalDays = 30;

function configureReservationRequestPolicy({ maxRentalDays }) {
  configuredMaxRentalDays = maxRentalDays;
}

function failure(code, error) {
  return { error: { code, message: error } };
}

function containsControlCharacters(value, allowLayout = false) {
  const pattern = allowLayout ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u : /[\u0000-\u001F\u007F-\u009F]/u;
  return pattern.test(value);
}

function normalizeVehicleId(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    value = Number(trimmed);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeRequiredName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > RESERVATION_REQUEST_LIMITS.customerName || containsControlCharacters(normalized)) return null;
  return normalized;
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (!normalized || normalized.length > RESERVATION_REQUEST_LIMITS.customerEmail || containsControlCharacters(normalized)) return null;
  const parts = normalized.split("@");
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || !parts[1].includes(".") || parts[1].startsWith(".") || parts[1].endsWith(".")) return null;
  if (!/^[^\s@]+@[^\s@]+$/u.test(normalized)) return null;
  return normalized;
}

function normalizePhone(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > RESERVATION_REQUEST_LIMITS.customerPhone || !/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const leadingPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `${leadingPlus ? "+" : ""}${digits}`;
}

function normalizeNotes(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  if (normalized.length > RESERVATION_REQUEST_LIMITS.customerNotes || containsControlCharacters(normalized, true)) return null;
  return normalized;
}

function validateReservationRequest(input, options = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const vehicleId = normalizeVehicleId(source.vehicleId);
  if (!vehicleId) return failure("INVALID_VEHICLE_ID", "vehicleId must be a positive integer");

  const customerName = normalizeRequiredName(source.customerName);
  if (!customerName) return failure("INVALID_CUSTOMER_NAME", "customerName must be a valid non-empty name of at most 160 characters");

  const customerEmail = normalizeEmail(source.customerEmail);
  if (!customerEmail) return failure("INVALID_EMAIL", "customerEmail must be a valid email address of at most 160 characters");

  const customerPhone = normalizePhone(source.customerPhone);
  if (customerPhone === null) return failure("INVALID_PHONE", "customerPhone must contain 7 to 15 digits and may use common separators");

  const customerNotes = normalizeNotes(source.notes ?? source.customerNotes);
  if (customerNotes === null) return failure("INVALID_NOTES", "notes must be text of at most 1000 characters without unsafe control characters");

  const pickupAt = parseTimestamp(source.pickupAt);
  if (!pickupAt) return failure("INVALID_PICKUP_TIME", "pickupAt must be a valid America/Chicago local timestamp or include an offset");
  const returnAt = parseTimestamp(source.returnAt);
  if (!returnAt) return failure("INVALID_RETURN_TIME", "returnAt must be a valid America/Chicago local timestamp or include an offset");

  const pickupTime = new Date(pickupAt).getTime();
  const returnTime = new Date(returnAt).getTime();
  if (returnTime <= pickupTime) return failure("INVALID_RETURN_TIME", "returnAt must be after pickupAt");

  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (pickupTime < now.getTime()) return failure("PICKUP_IN_PAST", "pickupAt must not be in the past");

  const maxRentalDays = options.maxRentalDays ?? configuredMaxRentalDays;
  if (returnTime - pickupTime > maxRentalDays * 24 * 60 * 60 * 1000) {
    return failure("RENTAL_DURATION_EXCEEDED", `The rental duration must not exceed ${maxRentalDays} days`);
  }

  return {
    value: { vehicleId, customerName, customerEmail, customerPhone, customerNotes, pickupAt, returnAt }
  };
}

function validateIdempotencyKey(value) {
  if (typeof value !== "string") return failure("INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key header is required");
  const key = value.trim();
  if (key.length < RESERVATION_REQUEST_LIMITS.idempotencyKeyMin
    || key.length > RESERVATION_REQUEST_LIMITS.idempotencyKeyMax
    || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    return failure("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 16 to 128 safe opaque characters");
  }
  return { value: key };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function reservationRequestHash(value) {
  return sha256(JSON.stringify([
    value.vehicleId,
    value.customerName,
    value.customerEmail,
    value.customerPhone,
    value.pickupAt,
    value.returnAt,
    value.customerNotes
  ]));
}

module.exports = {
  RESERVATION_REQUEST_LIMITS,
  configureReservationRequestPolicy,
  normalizeEmail,
  normalizePhone,
  normalizeVehicleId,
  reservationRequestHash,
  sha256,
  validateIdempotencyKey,
  validateReservationRequest
};
