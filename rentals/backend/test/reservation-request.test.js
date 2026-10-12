const assert = require("node:assert/strict");
const test = require("node:test");

const {
  reservationRequestHash,
  validateIdempotencyKey,
  validateReservationRequest
} = require("../utils/reservationRequestPolicy");

const NOW = new Date("2030-01-01T00:00:00.000Z");

function validRequest(overrides = {}) {
  return {
    vehicleId: 7,
    customerName: "José O’Connor-李",
    customerEmail: " Customer@Example.TEST ",
    customerPhone: "+1 (615) 470-5075",
    pickupAt: "2030-01-10T10:00:00Z",
    returnAt: "2030-01-12T10:00:00Z",
    notes: "Please call on arrival.",
    ...overrides
  };
}

function validate(overrides = {}, options = {}) {
  return validateReservationRequest(validRequest(overrides), { now: NOW, maxRentalDays: 30, ...options });
}

test("reservation requests normalize valid international customer input", () => {
  const result = validate();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, {
    vehicleId: 7,
    customerName: "José O’Connor-李",
    customerEmail: "customer@example.test",
    customerPhone: "+16154705075",
    customerNotes: "Please call on arrival.",
    pickupAt: "2030-01-10T10:00:00.000Z",
    returnAt: "2030-01-12T10:00:00.000Z"
  });
  assert.equal(reservationRequestHash(result.value), reservationRequestHash(validate({ customerEmail: "customer@example.test" }).value));
});

test("reservation request validation returns stable field codes", () => {
  const cases = [
    [{ customerName: "   " }, "INVALID_CUSTOMER_NAME"],
    [{ customerName: "x".repeat(161) }, "INVALID_CUSTOMER_NAME"],
    [{ customerName: { value: "Customer" } }, "INVALID_CUSTOMER_NAME"],
    [{ customerEmail: "not-an-email" }, "INVALID_EMAIL"],
    [{ customerEmail: `${"a".repeat(150)}@example.test` }, "INVALID_EMAIL"],
    [{ customerEmail: ["customer@example.test"] }, "INVALID_EMAIL"],
    [{ customerPhone: "615-CALL-NOW" }, "INVALID_PHONE"],
    [{ customerPhone: { number: "6154705075" } }, "INVALID_PHONE"],
    [{ pickupAt: undefined }, "INVALID_PICKUP_TIME"],
    [{ returnAt: undefined }, "INVALID_RETURN_TIME"],
    [{ returnAt: "2030-01-10T10:00:00Z" }, "INVALID_RETURN_TIME"],
    [{ returnAt: "2030-01-09T10:00:00Z" }, "INVALID_RETURN_TIME"],
    [{ pickupAt: "2029-12-31T23:59:59Z" }, "PICKUP_IN_PAST"],
    [{ pickupAt: "2030-03-10T02:30:00", returnAt: "2030-03-10T04:00:00" }, "INVALID_PICKUP_TIME"],
    [{ notes: "x".repeat(1001) }, "INVALID_NOTES"],
    [{ notes: { text: "hello" } }, "INVALID_NOTES"]
  ];
  for (const [input, code] of cases) assert.equal(validate(input).error.code, code);
});

test("vehicle identifiers reject partial, unsafe, non-positive, and structured values", () => {
  const invalid = ["7x", "1.5", 1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1, [], {}, [7]];
  for (const vehicleId of invalid) assert.equal(validate({ vehicleId }).error.code, "INVALID_VEHICLE_ID");
  assert.equal(validate({ vehicleId: " 7 " }).value.vehicleId, 7);
});

test("phone is optional and maximum rental duration has an exact boundary", () => {
  assert.equal(validate({ customerPhone: "" }).value.customerPhone, "");
  assert.equal(validate({ pickupAt: "2030-01-01T00:00:00Z", returnAt: "2030-01-31T00:00:00Z" }).error, undefined);
  assert.equal(
    validate({ pickupAt: "2030-01-01T00:00:00Z", returnAt: "2030-01-31T00:00:01Z" }).error.code,
    "RENTAL_DURATION_EXCEEDED"
  );
});

test("idempotency keys are trimmed and constrained without exposing their value", () => {
  assert.equal(validateIdempotencyKey("  12345678-1234-4234-8234-123456789abc  ").value, "12345678-1234-4234-8234-123456789abc");
  for (const value of [undefined, "short", "x".repeat(129), "invalid key with spaces", {}, []]) {
    const result = validateIdempotencyKey(value);
    assert.equal(result.error.code, "INVALID_IDEMPOTENCY_KEY");
  }
  assert.doesNotMatch(validateIdempotencyKey("private invalid key").error.message, /private invalid key/);
});
