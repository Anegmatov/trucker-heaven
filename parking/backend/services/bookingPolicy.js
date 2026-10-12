const { DateTime } = require('luxon');
const config = require('../config');
const { apiError } = require('../utils');
const { assertSupportedPublicDuration } = require('./publicParkingProducts');

function durationFor(start, end, timezone = 'UTC') {
  const days = DateTime.fromISO(end, { zone: 'utc' }).setZone(timezone)
    .diff(DateTime.fromISO(start, { zone: 'utc' }).setZone(timezone), 'days').days;
  return days >= config.bookingPolicy.minimumMonthlyDays ? 'MONTHLY' : 'DAILY';
}

function unitsFor(start, end, duration, timezone = 'UTC') {
  const days = DateTime.fromISO(end, { zone: 'utc' }).setZone(timezone)
    .diff(DateTime.fromISO(start, { zone: 'utc' }).setZone(timezone), 'days').days;
  // Monthly parking is a recurring subscription product. The selected
  // arrival/departure interval protects capacity; it must not turn a calendar
  // month with 31 days into two recurring charges. Stripe renews the one-month
  // price after checkout, so every Monthly quote starts with exactly one unit.
  if (duration === 'MONTHLY') return 1;
  if (duration === 'WEEKLY') return Math.max(1, Math.ceil(days / 7));
  return Math.max(1, Math.ceil(days));
}

// Reservation departure remains NULL for active Monthly parking. Exact-space
// holds require a finite timestamp, so this is only for hold calculations.
function monthlyOccupancyEnd() { return '9999-12-31T23:59:59.999Z'; }

function requestedDuration(value, start, end, timezone = 'UTC') {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (!end) throw apiError('MONTHLY_TERM_REQUIRED', 'Choose Monthly Parking for an open-ended reservation', 422);
    return durationFor(start, end, timezone);
  }
  return assertSupportedPublicDuration(value);
}

function validateBookingPolicy(start, end, timezone, requested = null, now = Date.now()) {
  const startMs = new Date(start).getTime();
  const policy = config.bookingPolicy;
  if (startMs < now + policy.minimumLeadMinutes * 60000) {
    throw apiError('BOOKING_START_TOO_SOON', `Arrival must be at least ${policy.minimumLeadMinutes} minutes from now`, 422);
  }
  if (startMs > now + policy.maximumHorizonDays * 86400000) {
    throw apiError('BOOKING_TOO_FAR_IN_ADVANCE', `Arrival cannot be more than ${policy.maximumHorizonDays} days in advance`, 422);
  }
  const duration = requested ? assertSupportedPublicDuration(requested) : durationFor(start, end, timezone);
  if (duration === 'MONTHLY' || (duration === 'WEEKLY' && !end)) return duration;
  if (!end) throw apiError('INVALID_BOOKING_INTERVAL', 'Departure is required for this parking term', 422);
  const endMs = new Date(end).getTime();
  const localDays = DateTime.fromISO(end, { zone: 'utc' }).setZone(timezone)
    .diff(DateTime.fromISO(start, { zone: 'utc' }).setZone(timezone), 'days').days;
  if (duration === 'WEEKLY' && localDays < policy.minimumWeeklyDays) {
    throw apiError('WEEKLY_STAY_TOO_SHORT', `Weekly parking requires a minimum ${policy.minimumWeeklyDays}-day stay`, 422);
  }
  const elapsedDays = (endMs - startMs) / 86400000;
  const maximumDays = duration === 'WEEKLY' ? policy.maximumWeeklyDays : policy.maximumDailyDays;
  if (elapsedDays > maximumDays) {
    throw apiError('BOOKING_STAY_TOO_LONG', `This ${duration.toLowerCase()} booking cannot exceed ${maximumDays} days`, 422);
  }
  return duration;
}

module.exports = { durationFor, unitsFor, requestedDuration, validateBookingPolicy, monthlyOccupancyEnd };
