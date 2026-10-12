const INSPECTION_TYPES = Object.freeze({ PICKUP: "PICKUP", RETURN: "RETURN" });
const MAX_NOTES_LENGTH = 1000;
const MAX_KEYS_COUNT = 20;

function inspectionError(code) {
  const error = new Error("Inspection input is invalid");
  error.statusCode = 400;
  error.code = code;
  return error;
}

function integer(value, code, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw inspectionError(code);
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") throw inspectionError(code);
  if (typeof value === "string" && !/^\d+$/.test(value)) throw inspectionError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw inspectionError(code);
  return parsed;
}

function boolean(value, code, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw inspectionError(code);
    return null;
  }
  if (typeof value !== "boolean") throw inspectionError(code);
  return value;
}

function notes(value, code, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw inspectionError(code);
    return null;
  }
  if (typeof value !== "string" || value.length > MAX_NOTES_LENGTH || /[\u0000-\u001F\u007F]/.test(value)) throw inspectionError(code);
  return value;
}

function validateInspection(input, inspectionType) {
  if (!Object.values(INSPECTION_TYPES).includes(inspectionType) || !input || typeof input !== "object" || Array.isArray(input)) throw inspectionError("INVALID_INSPECTION");
  const damageObserved = boolean(input.damageObserved, "INVALID_DAMAGE_OBSERVED");
  const damageNotes = notes(input.damageNotes, "INVALID_DAMAGE_NOTES", { required: damageObserved });
  if (!damageObserved && damageNotes !== null) throw inspectionError("INVALID_DAMAGE_NOTES");
  const result = {
    odometer: integer(input.odometer, "INVALID_ODOMETER"),
    fuelLevelPercent: integer(input.fuelLevelPercent, "INVALID_FUEL_LEVEL", { min: 0, max: 100 }),
    damageObserved,
    damageNotes,
    cleanlinessNotes: notes(input.cleanlinessNotes, "INVALID_CLEANLINESS_NOTES"),
    keysCount: integer(input.keysCount, "INVALID_KEYS_COUNT", { min: 0, max: MAX_KEYS_COUNT }),
    accessoriesNotes: notes(input.accessoriesNotes, "INVALID_ACCESSORIES_NOTES"),
    allExpectedKeysReturned: null,
    accessoriesReturned: null
  };
  if (inspectionType === INSPECTION_TYPES.RETURN) {
    result.allExpectedKeysReturned = boolean(input.allExpectedKeysReturned, "INVALID_EXPECTED_KEYS_RETURNED");
    result.accessoriesReturned = boolean(input.accessoriesReturned, "INVALID_ACCESSORIES_RETURNED");
  }
  return result;
}

module.exports = { INSPECTION_TYPES, MAX_KEYS_COUNT, MAX_NOTES_LENGTH, inspectionError, validateInspection };
