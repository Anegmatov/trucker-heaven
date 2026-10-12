const { DateTime } = require('luxon');
const { apiError, token } = require('../utils');

const paymentMethods = Object.freeze(['CASH', 'CLOVER', 'CARD', 'CHECK', 'OTHER']);
const paymentStatuses = Object.freeze(['PAID', 'DUE', 'PARTIAL', 'OVERDUE', 'NOT_DUE']);

function monthStart(value) {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(String(value || '').trim());
  if (!match) throw apiError('VALIDATION_ERROR', 'Billing period must be YYYY-MM');
  const date = DateTime.fromISO(`${match[1]}-${match[2]}-01`, { zone: 'utc' });
  if (!date.isValid) throw apiError('VALIDATION_ERROR', 'Choose a valid billing period');
  return date.toISODate();
}

function isoDate(value, label = 'Date') {
  const date = DateTime.fromISO(String(value || ''), { zone: 'utc' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) || !date.isValid) {
    throw apiError('VALIDATION_ERROR', `${label} must be YYYY-MM-DD`);
  }
  return date.toISODate();
}

function normalizedPlate(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizedDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizedAuthority(value) {
  const match = String(value || '').toUpperCase().match(/(?:USDOT|DOT|MC)?\s*#?\s*(\d{1,12})/);
  return match ? match[1] : null;
}

function paymentMethod(value) {
  const method = String(value || '').trim().toUpperCase();
  if (!paymentMethods.includes(method)) throw apiError('VALIDATION_ERROR', 'Choose Cash, Clover, Card, Check, or Other');
  return method;
}

function wholeCents(value, label = 'Amount', { allowNegative = false, allowZero = false } = {}) {
  const amount = Number(value);
  const validSign = allowNegative ? (allowZero ? true : amount !== 0) : (allowZero ? amount >= 0 : amount > 0);
  if (!Number.isSafeInteger(amount) || !validSign) {
    throw apiError('VALIDATION_ERROR', `${label} must be ${allowNegative ? 'non-zero ' : 'positive '}whole cents`);
  }
  return amount;
}

function dueDateForPeriod(periodStart, _arrivalAt) {
  const period = DateTime.fromISO(periodStart, { zone: 'utc' });
  return period.startOf('month').toISODate();
}

async function ensureMonthlyBillingPeriod(client, booking, {
  periodStart,
  amountDueCents,
  dueDate = null,
  source = 'BOOKING'
}) {
  if (!booking?.customer_id || !booking?.id || booking.parking_product !== 'MONTHLY') {
    throw apiError('MONTHLY_BILLING_BOOKING_REQUIRED', 'A canonical Monthly reservation is required for this billing period', 409);
  }
  const month = monthStart(periodStart);
  const due = wholeCents(amountDueCents, 'Amount due', { allowZero: true });
  const date = dueDate ? isoDate(dueDate, 'Due date') : dueDateForPeriod(month, booking.arrival_at);
  const result = await client.query(`INSERT INTO parking_customer_billing_periods(
      public_id,customer_id,booking_id,period_start,amount_due_cents,due_date,currency,source)
    VALUES($1,$2,$3,$4,$5,$6,'usd',$7)
    ON CONFLICT (customer_id,booking_id,period_start) WHERE booking_id IS NOT NULL
    DO UPDATE SET amount_due_cents=EXCLUDED.amount_due_cents,due_date=EXCLUDED.due_date,updated_at=now()
    RETURNING *`, [`bill_${token(24)}`, booking.customer_id, booking.id, month, due, date, source]);
  return result.rows[0];
}

async function ensureBookingPeriod(client, customerId, periodStart) {
  const month = monthStart(periodStart);
  // Prefer a charge that still has money owing, oldest due first.
  const existing = await client.query(`SELECT period.* FROM parking_customer_billing_periods period
    LEFT JOIN parking_customer_billing_period_balances balance ON balance.id=period.id
    WHERE period.customer_id=$1 AND period.period_start=$2
    ORDER BY (COALESCE(balance.balance_cents,0)>0) DESC,period.due_date,period.booking_id NULLS LAST,period.id
    LIMIT 1 FOR UPDATE OF period`, [customerId, month]);
  if (existing.rowCount) return existing.rows[0];
  const booking = (await client.query(`SELECT booking.*,price.snapshot
    FROM parking_bookings booking
    JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
    WHERE booking.customer_id=$1 AND booking.parking_product='MONTHLY'
      AND booking.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT','COMPLETED')
      AND booking.arrival_at < ($2::date + interval '1 month')
      AND (booking.departure_at IS NULL
        OR booking.departure_at >= $2::date
        OR booking.billing_period_end_at >= $2::date
        OR booking.subscription_status IN ('ACTIVE','TRIALING','PAST_DUE','PAYMENT_ACTION_REQUIRED'))
    ORDER BY booking.arrival_at DESC,booking.id DESC LIMIT 1 FOR UPDATE OF booking`, [customerId, month])).rows[0];
  if (!booking) throw apiError('BILLING_PERIOD_NOT_FOUND', 'No canonical Monthly reservation supports that billing period', 409);
  const initialMonth = DateTime.fromISO(booking.arrival_at, { zone: 'utc' }).toFormat('yyyy-MM');
  const amountDue = month === initialMonth
    ? Number(booking.snapshot?.totalCents)
    : Number(booking.snapshot?.recurringUnitRateCents ?? booking.snapshot?.unitRateCents);
  if (!Number.isSafeInteger(amountDue) || amountDue < 0) {
    throw apiError('BILLING_AMOUNT_INVALID', 'The reservation price snapshot cannot create a billing obligation', 409);
  }
  return ensureMonthlyBillingPeriod(client, booking, { periodStart: month, amountDueCents: amountDue });
}

async function periodBalance(client, periodId) {
  const row = (await client.query('SELECT * FROM parking_customer_billing_period_balances WHERE id=$1', [periodId])).rows[0];
  if (!row) throw apiError('BILLING_PERIOD_NOT_FOUND', 'Billing period not found', 404);
  return row;
}

module.exports = {
  paymentMethods, paymentStatuses, monthStart, isoDate, normalizedPlate, normalizedDigits,
  normalizedAuthority, paymentMethod, wholeCents, dueDateForPeriod,
  ensureMonthlyBillingPeriod, ensureBookingPeriod, periodBalance
};
