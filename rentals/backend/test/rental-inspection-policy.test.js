const assert = require("node:assert/strict");
const test = require("node:test");
const { INSPECTION_TYPES, validateInspection } = require("../utils/rentalInspectionPolicy");

const pickup = { odometer: 1200, fuelLevelPercent: 80, damageObserved: false, cleanlinessNotes: "Clean", keysCount: 2, accessoriesNotes: "Two fobs" };

test("rental inspection policy accepts bounded pickup and return evidence", () => {
  assert.deepEqual(validateInspection(pickup, INSPECTION_TYPES.PICKUP), { ...pickup, damageNotes: null, allExpectedKeysReturned: null, accessoriesReturned: null });
  assert.equal(validateInspection({ ...pickup, damageObserved: true, damageNotes: "Existing scratch", allExpectedKeysReturned: true, accessoriesReturned: false }, INSPECTION_TYPES.RETURN).allExpectedKeysReturned, true);
});

test("rental inspection policy rejects malformed numeric, boolean, and note fields", () => {
  for (const input of [
    { ...pickup, odometer: "12.5" }, { ...pickup, odometer: [] }, { ...pickup, fuelLevelPercent: 101 },
    { ...pickup, fuelLevelPercent: -1 }, { ...pickup, damageObserved: true }, { ...pickup, keysCount: 21 },
    { ...pickup, cleanlinessNotes: "bad\nnotes" }, { ...pickup, accessoriesNotes: "x".repeat(1001) }
  ]) assert.throws(() => validateInspection(input, INSPECTION_TYPES.PICKUP), /Inspection input is invalid/);
  assert.throws(() => validateInspection({ ...pickup, allExpectedKeysReturned: true }, INSPECTION_TYPES.RETURN), /Inspection input is invalid/);
});
