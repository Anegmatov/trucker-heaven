const assert = require("node:assert/strict");
const test = require("node:test");

const { vehicleMutationError } = require("../routes/adminVehicles");

test("vehicle uniqueness conflicts return stable, specific client errors", () => {
  assert.deepEqual(vehicleMutationError({ code: "23505", constraint: "vehicles_platenumber_key" }), {
    statusCode: 409,
    code: "DUPLICATE_PLATE_NUMBER",
    message: "A vehicle with this plate number already exists"
  });
  assert.deepEqual(vehicleMutationError({ code: "23505", constraint: "vehicles_vin_key" }), {
    statusCode: 409,
    code: "DUPLICATE_VIN",
    message: "A vehicle with this VIN already exists"
  });
  assert.equal(vehicleMutationError({ code: "22001" }), null);
});
