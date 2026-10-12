const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BUSINESS_TIME_ZONE,
  OPERATIONAL_STATUSES,
  RESERVATION_STATUSES,
  isAllowedReservationTransition,
  isBlockingReservationStatus,
  isOperationallyAvailable,
  normalizeOperationalStatus,
  parseAvailabilityInterval,
  parseTimestamp,
  rangesOverlap
} = require("../utils/reservationPolicy");
const { isAvailabilityConflict } = require("../routes/reservations");
const { formatReservationRequestNumber } = require("../utils/reservationNumber");

test("operational status is independent from reservation status", () => {
  assert.equal(normalizeOperationalStatus("Reserved"), OPERATIONAL_STATUSES.READY);
  assert.equal(normalizeOperationalStatus("Rented"), OPERATIONAL_STATUSES.OUT_OF_SERVICE);
  assert.equal(isOperationallyAvailable("READY"), true);
  assert.equal(isOperationallyAvailable("MAINTENANCE"), false);
  assert.equal(isBlockingReservationStatus("PENDING_REQUEST"), false);
  assert.equal(isBlockingReservationStatus("CONFIRMED"), true);
  assert.equal(isBlockingReservationStatus("READY_FOR_PICKUP"), true);
  assert.equal(isBlockingReservationStatus("CHECKED_OUT"), true);
  assert.equal(isBlockingReservationStatus("RETURNED_PENDING_INSPECTION"), true);
});

test("half-open reservation intervals allow adjacent bookings but reject overlap", () => {
  assert.equal(rangesOverlap("2030-01-10T10:00:00Z", "2030-01-12T10:00:00Z", "2030-01-12T10:00:00Z", "2030-01-13T10:00:00Z"), false);
  assert.equal(rangesOverlap("2030-01-10T10:00:00Z", "2030-01-12T10:00:00Z", "2030-01-11T10:00:00Z", "2030-01-13T10:00:00Z"), true);
});

test("reservation transitions are explicit and terminal states cannot move", () => {
  assert.equal(isAllowedReservationTransition("PENDING_REQUEST", RESERVATION_STATUSES.CONFIRMED), true);
  assert.equal(isAllowedReservationTransition("CONFIRMED", RESERVATION_STATUSES.READY_FOR_PICKUP), true);
  assert.equal(isAllowedReservationTransition("READY_FOR_PICKUP", RESERVATION_STATUSES.CHECKED_OUT), true);
  assert.equal(isAllowedReservationTransition("CHECKED_OUT", RESERVATION_STATUSES.RETURNED_PENDING_INSPECTION), true);
  assert.equal(isAllowedReservationTransition("RETURNED_PENDING_INSPECTION", RESERVATION_STATUSES.COMPLETED), true);
  assert.equal(isAllowedReservationTransition("CONFIRMED", RESERVATION_STATUSES.NO_SHOW), true);
  assert.equal(isAllowedReservationTransition("PENDING_REQUEST", RESERVATION_STATUSES.NO_SHOW), false);
  assert.equal(isAllowedReservationTransition("CHECKED_OUT", RESERVATION_STATUSES.NO_SHOW), false);
  assert.equal(isAllowedReservationTransition("PENDING_REQUEST", RESERVATION_STATUSES.COMPLETED), false);
  assert.equal(isAllowedReservationTransition("COMPLETED", RESERVATION_STATUSES.CONFIRMED), false);
  assert.equal(isAvailabilityConflict({ code: "23P01" }), true);
});

test("reservation request numbers are stable and do not require stored state", () => {
  assert.equal(formatReservationRequestNumber(1), "R-0001");
  assert.equal(formatReservationRequestNumber("123"), "R-0123");
  assert.equal(formatReservationRequestNumber(1234567), "R-1234567");
  assert.equal(formatReservationRequestNumber(0), "");
  assert.equal(formatReservationRequestNumber("unsafe"), "");
});

test("availability intervals reject incomplete, equal, reversed, and DST-gap inputs", () => {
  assert.equal(parseAvailabilityInterval({ pickupAt: "2030-01-10T10:00" }).error, "pickupAt and returnAt must be provided together");
  assert.match(parseAvailabilityInterval({ pickupAt: "2030-01-10T10:00", returnAt: "2030-01-10T10:00" }).error, /after/);
  assert.match(parseAvailabilityInterval({ pickupAt: "2030-01-11T10:00", returnAt: "2030-01-10T10:00" }).error, /after/);
  assert.equal(parseTimestamp("2026-03-08T02:30"), null);
  assert.equal(parseTimestamp("2026-03-08T01:30"), "2026-03-08T07:30:00.000Z");
  assert.equal(parseTimestamp("2026-11-01T01:30"), "2026-11-01T06:30:00.000Z");
  assert.equal(BUSINESS_TIME_ZONE, "America/Chicago");
});
