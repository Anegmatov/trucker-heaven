const BUSINESS_TIME_ZONE = "America/Chicago";

const OPERATIONAL_STATUSES = Object.freeze({
  READY: "READY",
  MAINTENANCE: "MAINTENANCE",
  OUT_OF_SERVICE: "OUT_OF_SERVICE",
  RETIRED: "RETIRED"
});

const RESERVATION_STATUSES = Object.freeze({
  PENDING_REQUEST: "PENDING_REQUEST",
  CONFIRMED: "CONFIRMED",
  READY_FOR_PICKUP: "READY_FOR_PICKUP",
  DECLINED: "DECLINED",
  CANCELLED: "CANCELLED",
  CHECKED_OUT: "CHECKED_OUT",
  RETURNED_PENDING_INSPECTION: "RETURNED_PENDING_INSPECTION",
  COMPLETED: "COMPLETED",
  NO_SHOW: "NO_SHOW"
});

const BLOCKING_RESERVATION_STATUSES = Object.freeze([
  RESERVATION_STATUSES.CONFIRMED,
  RESERVATION_STATUSES.READY_FOR_PICKUP,
  RESERVATION_STATUSES.CHECKED_OUT,
  RESERVATION_STATUSES.RETURNED_PENDING_INSPECTION
]);

const TERMINAL_RESERVATION_STATUSES = Object.freeze([
  RESERVATION_STATUSES.COMPLETED,
  RESERVATION_STATUSES.DECLINED,
  RESERVATION_STATUSES.CANCELLED,
  RESERVATION_STATUSES.NO_SHOW
]);

const RESERVATION_OPERATIONS = Object.freeze({
  CONFIRM: Object.freeze({ target: RESERVATION_STATUSES.CONFIRMED, label: "Confirm", roles: ["OWNER", "STAFF"] }),
  DECLINE: Object.freeze({ target: RESERVATION_STATUSES.DECLINED, label: "Decline", roles: ["OWNER", "STAFF"], allowsReason: true }),
  CANCEL: Object.freeze({ target: RESERVATION_STATUSES.CANCELLED, label: "Cancel", roles: ["OWNER", "STAFF"], allowsReason: true }),
  READY_FOR_PICKUP: Object.freeze({ target: RESERVATION_STATUSES.READY_FOR_PICKUP, label: "Ready for Pickup", roles: ["OWNER", "STAFF"] }),
  CHECK_OUT: Object.freeze({ target: RESERVATION_STATUSES.CHECKED_OUT, label: "Check Out", roles: ["OWNER", "STAFF"] }),
  MARK_RETURNED: Object.freeze({ target: RESERVATION_STATUSES.RETURNED_PENDING_INSPECTION, label: "Mark Returned", roles: ["OWNER", "STAFF"] }),
  COMPLETE: Object.freeze({ target: RESERVATION_STATUSES.COMPLETED, label: "Complete", roles: ["OWNER", "STAFF"] }),
  NO_SHOW: Object.freeze({ target: RESERVATION_STATUSES.NO_SHOW, label: "Mark No-show", roles: ["OWNER", "STAFF"], allowsReason: true })
});

const TRANSITIONS = Object.freeze({
  [RESERVATION_STATUSES.PENDING_REQUEST]: [RESERVATION_STATUSES.CONFIRMED, RESERVATION_STATUSES.DECLINED, RESERVATION_STATUSES.CANCELLED],
  [RESERVATION_STATUSES.CONFIRMED]: [RESERVATION_STATUSES.READY_FOR_PICKUP, RESERVATION_STATUSES.CANCELLED, RESERVATION_STATUSES.NO_SHOW],
  [RESERVATION_STATUSES.READY_FOR_PICKUP]: [RESERVATION_STATUSES.CHECKED_OUT, RESERVATION_STATUSES.CANCELLED, RESERVATION_STATUSES.NO_SHOW],
  [RESERVATION_STATUSES.CHECKED_OUT]: [RESERVATION_STATUSES.RETURNED_PENDING_INSPECTION],
  [RESERVATION_STATUSES.RETURNED_PENDING_INSPECTION]: [RESERVATION_STATUSES.COMPLETED],
  [RESERVATION_STATUSES.DECLINED]: [],
  [RESERVATION_STATUSES.CANCELLED]: [],
  [RESERVATION_STATUSES.COMPLETED]: [],
  [RESERVATION_STATUSES.NO_SHOW]: []
});

function normalizeOperationalStatus(status) {
  const value = String(status || "").trim().toUpperCase();
  const aliases = {
    AVAILABLE: OPERATIONAL_STATUSES.READY,
    READY: OPERATIONAL_STATUSES.READY,
    RESERVED: OPERATIONAL_STATUSES.READY,
    CLEANING: OPERATIONAL_STATUSES.MAINTENANCE,
    MAINTENANCE: OPERATIONAL_STATUSES.MAINTENANCE,
    SERVICE: OPERATIONAL_STATUSES.MAINTENANCE,
    RENTED: OPERATIONAL_STATUSES.OUT_OF_SERVICE,
    OUT_OF_SERVICE: OPERATIONAL_STATUSES.OUT_OF_SERVICE,
    INACTIVE: OPERATIONAL_STATUSES.RETIRED,
    UNAVAILABLE: OPERATIONAL_STATUSES.RETIRED,
    RETIRED: OPERATIONAL_STATUSES.RETIRED
  };
  return aliases[value] || OPERATIONAL_STATUSES.READY;
}

function normalizeReservationStatus(status) {
  const value = String(status || "").trim().toUpperCase();
  const aliases = {
    PENDING: RESERVATION_STATUSES.PENDING_REQUEST,
    PENDING_REQUEST: RESERVATION_STATUSES.PENDING_REQUEST,
    APPROVED: RESERVATION_STATUSES.CONFIRMED,
    RESERVED: RESERVATION_STATUSES.CONFIRMED,
    CONFIRMED: RESERVATION_STATUSES.CONFIRMED,
    READY_FOR_PICKUP: RESERVATION_STATUSES.READY_FOR_PICKUP,
    REJECTED: RESERVATION_STATUSES.DECLINED,
    DECLINED: RESERVATION_STATUSES.DECLINED,
    CANCELLED: RESERVATION_STATUSES.CANCELLED,
    ACTIVE: RESERVATION_STATUSES.CHECKED_OUT,
    RENTED: RESERVATION_STATUSES.CHECKED_OUT,
    CHECKED_OUT: RESERVATION_STATUSES.CHECKED_OUT,
    RETURNED_PENDING_INSPECTION: RESERVATION_STATUSES.RETURNED_PENDING_INSPECTION,
    CLOSED: RESERVATION_STATUSES.COMPLETED,
    COMPLETED: RESERVATION_STATUSES.COMPLETED,
    NO_SHOW: RESERVATION_STATUSES.NO_SHOW
  };
  return aliases[value] || "";
}

function isOperationallyAvailable(status) {
  return normalizeOperationalStatus(status) === OPERATIONAL_STATUSES.READY;
}

function isBlockingReservationStatus(status) {
  return BLOCKING_RESERVATION_STATUSES.includes(normalizeReservationStatus(status));
}

function isAllowedReservationTransition(currentStatus, nextStatus) {
  const current = normalizeReservationStatus(currentStatus);
  const next = normalizeReservationStatus(nextStatus);
  return current === next || Boolean(current && next && TRANSITIONS[current]?.includes(next));
}

function rangesOverlap(leftPickupAt, leftReturnAt, rightPickupAt, rightReturnAt) {
  return new Date(leftPickupAt).getTime() < new Date(rightReturnAt).getTime()
    && new Date(leftReturnAt).getTime() > new Date(rightPickupAt).getTime();
}

function dateTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function zoneOffsetMilliseconds(date, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = String(name || "").match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) throw new Error(`Unable to determine timezone offset for ${timeZone}`);
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return (match[1] === "+" ? 1 : -1) * minutes * 60 * 1000;
}

function parseTimestamp(value, timeZone = BUSINESS_TIME_ZONE) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", zone] = match;
  const numbers = [year, month, day, hour, minute, second].map(Number);
  const calendar = new Date(Date.UTC(numbers[0], numbers[1] - 1, numbers[2]));
  if (calendar.getUTCFullYear() !== numbers[0] || calendar.getUTCMonth() !== numbers[1] - 1 || calendar.getUTCDate() !== numbers[2]
    || numbers[3] > 23 || numbers[4] > 59 || numbers[5] > 59) return null;

  if (zone) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const localAsUtc = Date.UTC(numbers[0], numbers[1] - 1, numbers[2], numbers[3], numbers[4], numbers[5]);
  let timestamp = localAsUtc;
  for (let index = 0; index < 3; index += 1) {
    const candidate = localAsUtc - zoneOffsetMilliseconds(new Date(timestamp), timeZone);
    if (candidate === timestamp) break;
    timestamp = candidate;
  }
  const date = new Date(timestamp);
  const parts = dateTimeParts(date, timeZone);
  if (Number(parts.year) !== numbers[0] || Number(parts.month) !== numbers[1] || Number(parts.day) !== numbers[2]
    || Number(parts.hour) !== numbers[3] || Number(parts.minute) !== numbers[4] || Number(parts.second) !== numbers[5]) return null;
  return date.toISOString();
}

function parseAvailabilityInterval(input) {
  const pickupProvided = input.pickupAt !== undefined;
  const returnProvided = input.returnAt !== undefined;
  if (!pickupProvided && !returnProvided) return { interval: null };
  if (!pickupProvided || !returnProvided) return { error: "pickupAt and returnAt must be provided together" };
  const pickupAt = parseTimestamp(input.pickupAt);
  const returnAt = parseTimestamp(input.returnAt);
  if (!pickupAt || !returnAt) return { error: `pickupAt and returnAt must be valid timestamps in ${BUSINESS_TIME_ZONE} or include an offset` };
  if (new Date(returnAt).getTime() <= new Date(pickupAt).getTime()) return { error: "returnAt must be after pickupAt" };
  return { interval: { pickupAt, returnAt } };
}

module.exports = {
  BUSINESS_TIME_ZONE,
  OPERATIONAL_STATUSES,
  RESERVATION_STATUSES,
  BLOCKING_RESERVATION_STATUSES,
  TERMINAL_RESERVATION_STATUSES,
  RESERVATION_OPERATIONS,
  normalizeOperationalStatus,
  normalizeReservationStatus,
  isOperationallyAvailable,
  isBlockingReservationStatus,
  isAllowedReservationTransition,
  rangesOverlap,
  parseTimestamp,
  parseAvailabilityInterval
};
