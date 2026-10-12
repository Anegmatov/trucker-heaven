'use strict';

// Pay-on-site booking support.
//
// With PARKING_PAYMENT_MODE=PAY_ON_SITE, reservations become operational without
// any online payment: the customer pays at Trucker Heaven (Daily/Weekly when they
// leave, Monthly on the 1st) and staff record the payment in the customer ledger.
// Bookings carry payment_status='NOT_REQUIRED', which every existing read model
// already treats as financially eligible.

const { DateTime } = require('luxon');
const config = require('../config');
const { apiError, token } = require('../utils');
const { selectExactSpot, assignSelectedExactSpot, currentAssignment } = require('./exactSpaceService');
const { activateCustomerFromBooking } = require('./customerIdentity');
const { assertFinalBookingAvailability } = require('./parkingService');
const { monthlyOccupancyEnd } = require('./bookingPolicy');
const notifications = require('./customerNotifications');

function payOnSite() {
  return config.paymentMode === 'PAY_ON_SITE';
}

const DEFAULT_PAYMENT_INSTRUCTIONS = 'Pay at the Trucker Heaven office. Daily and Weekly parking is paid when you leave; Monthly parking is due on the 1st of each month.';

function paymentInstructions(location) {
  const configured = String(location?.payment_instructions || '').trim();
  // The original default only said "Payment is due at the parking location."
  if (!configured || configured === 'Payment is due at the parking location.') return DEFAULT_PAYMENT_INSTRUCTIONS;
  return configured;
}

// Turns a PENDING pay-on-site booking (manual approval mode, or a staff-created
// reservation) into CONFIRMED: re-checks capacity, assigns the selected Monthly
// space, activates the customer record and queues the confirmation message.
async function confirmOnSiteBooking(client, booking, { actorType = 'ADMIN', adminUserId = null, reason = 'Confirmed for payment on site', note = null } = {}) {
  if (booking.status !== 'PENDING') throw apiError('BOOKING_TRANSITION_NOT_ALLOWED', 'Only pending reservations can be confirmed', 409);
  if (booking.payment_status !== 'NOT_REQUIRED') {
    throw apiError('PAYMENT_FINALIZATION_REQUIRED', 'This reservation was started with online payment and cannot be confirmed for payment on site', 409);
  }
  const slot = await assertFinalBookingAvailability(client, booking);
  // Any reservation that picked a numbered space (Monthly always; Daily/Weekly when the driver or
  // staff chose one) gets that space assigned now.
  if (booking.assignment_mode_snapshot === 'CUSTOMER_SELECTED_SPOT' || booking.parking_product === 'MONTHLY') {
    const existing = await currentAssignment(client, booking.id, { lock: true });
    if (!existing) {
      const spot = await selectExactSpot(client, {
        slot,
        arrival: booking.arrival_at,
        departure: booking.departure_at || monthlyOccupancyEnd(),
        preferredSpotId: booking.requested_parking_spot_id || null
      });
      await assignSelectedExactSpot(client, { booking, slot, spot, source: 'CUSTOMER_SELECTED', adminUserId, reason });
    }
  }
  const updated = (await client.query(`UPDATE parking_bookings SET status='CONFIRMED',pending_expires_at=NULL,
      version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [booking.id])).rows[0];
  await client.query(`INSERT INTO parking_booking_status_history(booking_id,previous_status,new_status,actor_type,admin_user_id,reason,note,version)
    VALUES($1,'PENDING','CONFIRMED',$2,$3,$4,$5,$6)`, [booking.id, actorType, adminUserId, reason, note, Number(updated.version)]);
  const confirmed = { ...booking, ...updated };
  await activateCustomerFromBooking(client, confirmed);
  await ensureOnSiteCharges(client, confirmed);
  await notifications.enqueueForBooking(client, confirmed, 'RESERVATION_CONFIRMED');
  return confirmed;
}


// ---- On-site charges in the customer ledger ----
// Every confirmed pay-on-site reservation gets a billing period so staff see what is owed:
//   Daily/Weekly: the total, due on the departure date.
//   Monthly: the (prorated) first month, due on the start date; later months are added on the 1st
//            by ensureOnSiteMonthlyPeriods(). Cancelled/no-show reservations owe nothing (see the
//            balances view in migration 055).
const CHARGEABLE = ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'COMPLETED'];

async function bookingTimezone(client, booking) {
  if (booking.timezone) return booking.timezone;
  const row = (await client.query('SELECT timezone FROM parking_locations WHERE id=$1', [booking.location_id])).rows[0];
  return row?.timezone || 'America/Chicago';
}

// The desk's "final price" is what the customer owes for this reservation: the stay total for
// Daily/Weekly, and the (prorated) first month for Monthly. The monthly rate itself never changes.
async function onSitePricing(client, booking) {
  const snapshot = (await client.query('SELECT snapshot FROM parking_booking_price_snapshots WHERE booking_id=$1', [booking.id])).rows[0]?.snapshot || {};
  const override = (await client.query(`SELECT final_price_cents FROM parking_booking_price_overrides
    WHERE booking_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [booking.id])).rows[0];
  const total = Number(snapshot.totalCents ?? 0);
  const first = override ? Number(override.final_price_cents) : total;
  const unit = Number(snapshot.recurringUnitRateCents ?? snapshot.unitRateCents ?? total);
  return { firstCents: first, recurringCents: unit, unitRateCents: unit };
}

async function upsertOnSitePeriod(client, booking, { periodStart, amountDueCents, dueDate }) {
  if (!Number.isSafeInteger(amountDueCents) || amountDueCents < 0) throw apiError('BILLING_AMOUNT_INVALID', 'The reservation price cannot create a billing obligation', 409);
  return (await client.query(`INSERT INTO parking_customer_billing_periods(
      public_id,customer_id,booking_id,period_start,amount_due_cents,due_date,currency,source)
    VALUES($1,$2,$3,$4,$5,$6,'usd','ON_SITE')
    ON CONFLICT (customer_id,booking_id,period_start) WHERE booking_id IS NOT NULL
    DO UPDATE SET amount_due_cents=EXCLUDED.amount_due_cents,due_date=EXCLUDED.due_date,updated_at=now()
      WHERE parking_customer_billing_periods.source='ON_SITE'
    RETURNING *`, [`bill_${token(24)}`, booking.customer_id, booking.id, periodStart, amountDueCents, dueDate])).rows[0];
}

// Creates or refreshes the charge for one reservation. Safe to call repeatedly.
async function ensureOnSiteCharges(client, booking) {
  if (!booking?.customer_id || booking.payment_status !== 'NOT_REQUIRED' || !CHARGEABLE.includes(booking.status)) return null;
  const timezone = await bookingTimezone(client, booking);
  const local = value => DateTime.fromJSDate(new Date(value), { zone: 'utc' }).setZone(timezone);
  const pricing = await onSitePricing(client, booking);
  let anchor;
  if (booking.parking_product === 'MONTHLY') anchor = local(booking.arrival_at);
  else if (booking.departure_at) anchor = local(booking.departure_at);
  else return ensureOpenWeeklyPeriods(client, booking, { timezone, now: new Date() }); // open-ended Weekly
  const periodStart = anchor.startOf('month').toISODate();
  // Dates moved: drop unpaid charges that no longer match.
  await client.query(`DELETE FROM parking_customer_billing_periods period
    WHERE period.booking_id=$1 AND period.source='ON_SITE' AND period.period_start<>$2
      AND ($3::boolean OR period.period_start<$2)
      AND NOT EXISTS (SELECT 1 FROM parking_customer_payments payment WHERE payment.billing_period_id=period.id)`,
  [booking.id, periodStart, booking.parking_product !== 'MONTHLY']);
  return upsertOnSitePeriod(client, booking, { periodStart, amountDueCents: pricing.firstCents, dueDate: anchor.toISODate() });
}

// Open-ended Weekly parking: each month owes one weekly rate per week that starts in it, due on
// the first of those week starts. Charges are added as each month begins.
function weekStartsInMonth(arrival, departure, monthStart) {
  const monthEnd = monthStart.plus({ months: 1 });
  const starts = [];
  for (let start = arrival; start < monthEnd && (!departure || start < departure); start = start.plus({ days: 7 })) {
    if (start >= monthStart) starts.push(start);
  }
  return starts;
}

async function ensureOpenWeeklyPeriods(client, booking, { timezone, now }) {
  if (!booking?.customer_id || booking.payment_status !== 'NOT_REQUIRED' || !CHARGEABLE.includes(booking.status)) return null;
  const tz = timezone || await bookingTimezone(client, booking);
  const arrival = DateTime.fromJSDate(new Date(booking.arrival_at), { zone: 'utc' }).setZone(tz);
  const departure = booking.departure_at ? DateTime.fromJSDate(new Date(booking.departure_at), { zone: 'utc' }).setZone(tz) : null;
  const last = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(tz).startOf('month');
  const { unitRateCents } = await onSitePricing(client, booking);
  let created = null;
  for (let month = arrival.startOf('month'); month <= last; month = month.plus({ months: 1 })) {
    const starts = weekStartsInMonth(arrival, departure, month);
    if (!starts.length) continue;
    created = await upsertOnSitePeriod(client, booking, { periodStart: month.toISODate(), amountDueCents: starts.length * unitRateCents, dueDate: starts[0].toISODate() });
  }
  return created;
}

// Adds this month's charge for every active pay-on-site Monthly reservation (due on the 1st).
// Each booking runs in its own savepoint so one bad record never blocks the others.
async function ensureOnSiteMonthlyPeriods(client, now = new Date()) {
  const rows = (await client.query(`SELECT booking.*,location.timezone FROM parking_bookings booking
    JOIN parking_locations location ON location.id=booking.location_id
    WHERE booking.parking_product='MONTHLY' AND booking.payment_status='NOT_REQUIRED'
      AND booking.status IN ('CONFIRMED','CHECKED_IN') AND booking.customer_id IS NOT NULL`)).rows;
  let created = 0;
  for (const booking of rows) {
    await client.query('SAVEPOINT on_site_period');
    try {
      const month = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(booking.timezone).startOf('month');
      const arrivalMonth = DateTime.fromJSDate(new Date(booking.arrival_at), { zone: 'utc' }).setZone(booking.timezone).startOf('month');
      if (arrivalMonth >= month) { await client.query('RELEASE SAVEPOINT on_site_period'); continue; }
      if (booking.departure_at && new Date(booking.departure_at) < month.toJSDate()) { await client.query('RELEASE SAVEPOINT on_site_period'); continue; }
      // Skip if this booking already owes for the month, or the customer has an imported/manual charge for it.
      const exists = await client.query(`SELECT 1 FROM parking_customer_billing_periods
        WHERE period_start=$2 AND (booking_id=$1 OR (customer_id=$3 AND booking_id IS NULL))`, [booking.id, month.toISODate(), booking.customer_id]);
      if (!exists.rowCount) {
        const pricing = await onSitePricing(client, booking);
        await upsertOnSitePeriod(client, booking, { periodStart: month.toISODate(), amountDueCents: pricing.recurringCents, dueDate: month.toISODate() });
        created += 1;
      }
      await client.query('RELEASE SAVEPOINT on_site_period');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT on_site_period');
      console.error(JSON.stringify({ event: 'on_site_period.error', bookingId: Number(booking.id), message: error?.message || 'unknown' }));
    }
  }
  // Open-ended Weekly bookings roll forward too.
  const weekly = (await client.query(`SELECT booking.*,location.timezone FROM parking_bookings booking
    JOIN parking_locations location ON location.id=booking.location_id
    WHERE booking.parking_product='WEEKLY' AND booking.departure_at IS NULL AND booking.payment_status='NOT_REQUIRED'
      AND booking.status IN ('CONFIRMED','CHECKED_IN') AND booking.customer_id IS NOT NULL`)).rows;
  for (const booking of weekly) {
    await client.query('SAVEPOINT on_site_period');
    try { await ensureOpenWeeklyPeriods(client, booking, { timezone: booking.timezone, now }); await client.query('RELEASE SAVEPOINT on_site_period'); }
    catch (error) { await client.query('ROLLBACK TO SAVEPOINT on_site_period'); console.error(JSON.stringify({ event: 'on_site_period.error', bookingId: Number(booking.id), message: error?.message || 'unknown' })); }
  }
  return created;
}

module.exports = { payOnSite, paymentInstructions, confirmOnSiteBooking, ensureOnSiteCharges, ensureOnSiteMonthlyPeriods, DEFAULT_PAYMENT_INSTRUCTIONS };
