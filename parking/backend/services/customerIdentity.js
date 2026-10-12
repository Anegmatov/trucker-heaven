const { apiError, token, email, phone } = require('../utils');
const customerLedger = require('./customerLedger');

function normalizeEmail(value) { return email(value); }
function normalizePhone(value) { return phone(value); }

function normalizeIdentifier(value) {
  const raw = String(value || '').trim();
  if (!raw) throw apiError('VALIDATION_ERROR', 'Enter a phone number or email address');
  if (raw.includes('@')) return { channel: 'EMAIL', normalized: normalizeEmail(raw), display: raw };
  return { channel: 'SMS', normalized: normalizePhone(raw), display: raw };
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : '***-***-****';
}

function maskEmail(value) {
  const [local = '', domain = ''] = String(value || '').split('@');
  return `${local.slice(0, 1) || '*'}***@${domain || '***'}`;
}

function maskIdentifier(identity) {
  return identity.channel === 'SMS' ? maskPhone(identity.normalized) : maskEmail(identity.normalized);
}

async function resolveOrCreateCustomer(client, customer, { authenticatedCustomerId = null } = {}) {
  if (authenticatedCustomerId) {
    const authenticated = (await client.query(`SELECT * FROM parking_customers
      WHERE id=$1 AND status<>'SUSPENDED' FOR UPDATE`, [authenticatedCustomerId])).rows[0];
    if (!authenticated) throw apiError('AUTHENTICATION_REQUIRED', 'Your My Parking session has expired', 401);
    return { customer: authenticated, created: false, conflict: false };
  }
  const normalizedPhone = normalizePhone(customer.mobilePhone);
  const normalizedEmail = normalizeEmail(customer.email);
  // One deterministic lock order prevents opposite phone/email submissions
  // from deadlocking while still making the duplicate decision transactional.
  const matches = await client.query(`SELECT * FROM parking_customers
    WHERE normalized_phone=$1 OR normalized_email=$2 ORDER BY id FOR UPDATE`, [normalizedPhone, normalizedEmail]);
  const phoneCustomer = matches.rows.find(row => row.normalized_phone === normalizedPhone) || null;
  const emailCustomer = matches.rows.find(row => row.normalized_email === normalizedEmail) || null;
  if (phoneCustomer && emailCustomer && Number(phoneCustomer.id) !== Number(emailCustomer.id)) {
    const conflict = (await client.query(`INSERT INTO parking_customer_identity_conflicts(
        phone_customer_id,email_customer_id)
      VALUES($1,$2)
      ON CONFLICT (phone_customer_id,email_customer_id) WHERE status='OPEN'
      DO UPDATE SET occurrence_count=parking_customer_identity_conflicts.occurrence_count+1,last_detected_at=now()
      RETURNING id`, [phoneCustomer.id, emailCustomer.id])).rows[0];
    return { conflict: true, conflictId: Number(conflict.id) };
  }
  const existing = phoneCustomer || emailCustomer;
  if (existing) return { customer: existing, created: false, conflict: false };
  const created = (await client.query(`INSERT INTO parking_customers(
      public_id,first_name,last_name,normalized_phone,display_phone,normalized_email,display_email)
    VALUES($1,$2,$3,$4,$4,$5,$5) RETURNING *`, [
    `cust_${token(24)}`, customer.firstName, customer.lastName, normalizedPhone, normalizedEmail
  ])).rows[0];
  return { customer: created, created: true, conflict: false };
}

async function activateCustomerFromBooking(client, booking, stripeCustomerId = null) {
  if (!booking.customer_id) return null;
  const customer = (await client.query('SELECT * FROM parking_customers WHERE id=$1 FOR UPDATE', [booking.customer_id])).rows[0];
  if (!customer) throw apiError('CUSTOMER_ACCOUNT_INVALID', 'The reservation customer account is unavailable', 409);
  if (customer.stripe_customer_id && stripeCustomerId && customer.stripe_customer_id !== stripeCustomerId) {
    throw apiError('STRIPE_CUSTOMER_MISMATCH', 'Stripe customer does not match the ParkingOps customer account', 409);
  }
  // A suspended account is never reactivated by a new reservation; staff decide that.
  const updated = (await client.query(`UPDATE parking_customers SET status=CASE WHEN status='SUSPENDED' THEN status ELSE 'ACTIVE' END,
      stripe_customer_id=COALESCE(stripe_customer_id,$2) WHERE id=$1 RETURNING *`,
  [customer.id, stripeCustomerId])).rows[0];
  const classification = String(booking.category_code || booking.category_public_code || '').toUpperCase() === 'BOBTAIL'
    ? 'BOBTAIL' : 'GENERAL';
  await client.query(`INSERT INTO parking_customer_vehicles(
      public_id,customer_id,unit_number,license_plate,license_plate_state,vehicle_classification,last_used_at)
    VALUES($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (customer_id,upper(license_plate),upper(license_plate_state))
    WHERE license_plate IS NOT NULL AND license_plate_state IS NOT NULL
    DO UPDATE SET unit_number=EXCLUDED.unit_number,vehicle_classification=EXCLUDED.vehicle_classification,
      active=true,last_used_at=now()`, [
    `veh_${token(24)}`, customer.id, booking.tractor_unit_number,
    booking.license_plate, booking.license_plate_state, classification
  ]);
  return updated;
}

async function recordPayment(client, booking, {
  processorPaymentId, amountCents, currency, status, receiptUrl = null, paidAt = null,
  billingPeriodStart = null, amountDueCents = null, dueDate = null
}) {
  if (!booking.customer_id || !processorPaymentId) return null;
  const safeReceipt = /^https:\/\//i.test(String(receiptUrl || '')) ? String(receiptUrl) : null;
  const paymentDate = String(paidAt || new Date().toISOString()).slice(0, 10);
  const period = booking.parking_product === 'MONTHLY'
    ? await customerLedger.ensureMonthlyBillingPeriod(client, booking, {
      periodStart: String(billingPeriodStart || paymentDate).slice(0, 7),
      amountDueCents: amountDueCents ?? amountCents,
      dueDate,
      source: 'STRIPE'
    })
    : null;
  const result = await client.query(`INSERT INTO parking_customer_payments(
      public_id,customer_id,booking_id,processor,processor_payment_id,parking_product,amount_cents,currency,status,
      receipt_url,paid_at,billing_period_id,payment_source,payment_method,payment_date)
    VALUES($1,$2,$3,'STRIPE',$4,$5,$6,$7,$8,$9,$10,$11,'STRIPE','CARD',$12)
    ON CONFLICT (processor,processor_payment_id) DO UPDATE SET
      status=EXCLUDED.status,amount_cents=EXCLUDED.amount_cents,currency=EXCLUDED.currency,
      receipt_url=COALESCE(EXCLUDED.receipt_url,parking_customer_payments.receipt_url),
      paid_at=COALESCE(EXCLUDED.paid_at,parking_customer_payments.paid_at),
      billing_period_id=COALESCE(EXCLUDED.billing_period_id,parking_customer_payments.billing_period_id),
      payment_date=EXCLUDED.payment_date
    RETURNING *`, [
    `pay_${token(24)}`, booking.customer_id, booking.id, String(processorPaymentId),
    booking.parking_product, Number(amountCents || 0), String(currency || '').toLowerCase(), status,
    safeReceipt, paidAt, period?.id || null, paymentDate
  ]);
  return result.rows[0];
}

module.exports = {
  normalizeEmail, normalizePhone, normalizeIdentifier, maskIdentifier,
  resolveOrCreateCustomer, activateCustomerFromBooking, recordPayment
};
