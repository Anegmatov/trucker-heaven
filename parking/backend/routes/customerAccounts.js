const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const { DateTime } = require('luxon');
const pool = require('../db');
const config = require('../config');
const { apiError, token, digest, cleanText } = require('../utils');
const auth = require('../services/customerAuth');
const identity = require('../services/customerIdentity');
const stripeGateway = require('../services/stripeGateway');
const notifications = require('../services/customerNotifications');
const customerDocuments = require('../services/customerDocuments');
const demoPaymentBypass = require('../services/demoPaymentBypass');

const router = express.Router();
const authRequestLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PARKING_CUSTOMER_AUTH_REQUEST_RATE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => next(apiError('AUTH_REQUEST_RATE_LIMITED', 'Too many sign-in requests. Try again later.', 429))
});
const authVerifyLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PARKING_CUSTOMER_AUTH_VERIFY_RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => next(apiError('AUTH_VERIFY_RATE_LIMITED', 'Too many code attempts. Try again later.', 429))
});

router.post('/auth/request-code', authRequestLimit, async (req, res, next) => {
  try { res.status(202).json(await auth.requestCode(req)); } catch (error) { next(error); }
});

function normalizedName(body) {
  const full = cleanText(body.name, 161, 'Name', true).replace(/\s+/g, ' ').trim();
  const parts = full.split(' ');
  if (parts.length < 2) throw apiError('VALIDATION_ERROR', 'Enter first and last name.');
  return { firstName: parts.shift(), lastName: parts.join(' '), full: full.toLocaleLowerCase('en-US') };
}

function sameName(row, submitted) {
  return `${String(row.first_name || '').trim()} ${String(row.last_name || '').trim()}`
    .replace(/\s+/g, ' ').toLocaleLowerCase('en-US') === submitted.full;
}

function eligibleOfflineBooking(row) {
  return ['PAID','DEMO_BYPASSED'].includes(row.payment_status) || row.payment_confirmed_at
    || (row.payment_status === 'NOT_REQUIRED' && ['CONFIRMED','CHECKED_IN','CHECKED_OUT','COMPLETED'].includes(row.status));
}

router.post('/auth/start', authRequestLimit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const name = normalizedName(req.body || {});
    const normalizedPhone = identity.normalizePhone(req.body.phone);
    const normalizedEmail = identity.normalizeEmail(req.body.email);
    const preferredIdentifier = notifications.emailConfigured() ? normalizedEmail
      : notifications.smsConfigured() ? normalizedPhone : normalizedEmail;
    await client.query('BEGIN');
    const matches = await client.query(`SELECT * FROM parking_customers
      WHERE normalized_phone=$1 OR normalized_email=$2 ORDER BY id FOR UPDATE`, [normalizedPhone, normalizedEmail]);
    const phoneCustomer = matches.rows.find(row => row.normalized_phone === normalizedPhone) || null;
    const emailCustomer = matches.rows.find(row => row.normalized_email === normalizedEmail) || null;
    if (phoneCustomer && emailCustomer && Number(phoneCustomer.id) !== Number(emailCustomer.id)) {
      await client.query(`INSERT INTO parking_customer_identity_conflicts(phone_customer_id,email_customer_id)
        VALUES($1,$2) ON CONFLICT (phone_customer_id,email_customer_id) WHERE status='OPEN'
        DO UPDATE SET occurrence_count=parking_customer_identity_conflicts.occurrence_count+1,last_detected_at=now()`,
      [phoneCustomer.id, emailCustomer.id]);
      await client.query('COMMIT');
      const conflict = apiError('CUSTOMER_IDENTITY_CONFLICT',
        'Those details are protected by different My Parking accounts. Contact parking support; accounts were not merged.', 409);
      conflict.transactionFinalized = true;
      throw conflict;
    }
    let customer = phoneCustomer || emailCustomer;
    const exactExisting = Boolean(customer && customer.normalized_phone === normalizedPhone
      && customer.normalized_email === normalizedEmail && sameName(customer, name));
    let accessEligible = exactExisting;
    const candidates = (await client.query(`SELECT * FROM parking_bookings
      WHERE lower(trim(email))=$1 AND customer_id IS NULL
        AND (payment_status IN ('PAID','DEMO_BYPASSED') OR payment_confirmed_at IS NOT NULL OR
          (payment_status='NOT_REQUIRED' AND status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT','COMPLETED')))
      ORDER BY arrival_at DESC,id DESC FOR UPDATE`, [normalizedEmail])).rows.filter(row => {
      try { return identity.normalizePhone(row.mobile_phone) === normalizedPhone && sameName(row, name) && eligibleOfflineBooking(row); }
      catch (_) { return false; }
    });
    if (!customer && candidates.length) {
      const trusted = candidates[0];
      customer = (await client.query(`INSERT INTO parking_customers(
          public_id,first_name,last_name,normalized_phone,display_phone,normalized_email,display_email,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING') RETURNING *`, [
        `cust_${token(24)}`, trusted.first_name, trusted.last_name, normalizedPhone,
        trusted.mobile_phone, normalizedEmail, trusted.email
      ])).rows[0];
      accessEligible = true;
    }
    if (customer && accessEligible) {
      for (const booking of candidates) {
        await client.query('UPDATE parking_bookings SET customer_id=$2 WHERE id=$1 AND customer_id IS NULL',
          [booking.id, customer.id]);
      }
    }
    await client.query('COMMIT');
    res.status(202).json(await auth.requestCode(req, preferredIdentifier, { suppressDelivery: !accessEligible }));
  } catch (error) {
    if (!error.transactionFinalized) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/auth/verify-code', authVerifyLimit, async (req, res, next) => {
  try { res.json(await auth.verifyCode(req, res)); } catch (error) { next(error); }
});

router.get('/session', auth.requireCustomer, (req, res) => res.json({ customer: auth.customerView(req.customer) }));
router.get('/csrf', auth.requireCustomer, async (req, res, next) => {
  try { res.json({ csrfToken: await auth.rotateCsrf(req) }); } catch (error) { next(error); }
});
router.post('/logout', auth.requireCustomer, auth.csrf, async (req, res, next) => {
  try { await auth.logout(req, res); res.status(204).end(); } catch (error) { next(error); }
});

router.use(auth.requireCustomer);

function priceSnapshot(row) {
  const snapshot = row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {};
  return {
    totalCents: Number.isSafeInteger(Number(snapshot.totalCents)) ? Number(snapshot.totalCents) : null,
    unitRateCents: Number.isSafeInteger(Number(snapshot.unitRateCents)) ? Number(snapshot.unitRateCents) : null,
    currency: config.stripe.currency
  };
}

function reservationView(row) {
  const nextMonthlyBillingAt = row.parking_product === 'MONTHLY' && !row.departure_at
    ? DateTime.fromJSDate(new Date(row.arrival_at), { zone: 'utc' }).setZone(row.timezone || 'UTC').plus({ months: 1 }).startOf('month').toUTC().toISO() : null;
  return {
    reservationNumber: row.reservation_number,
    parkingProduct: row.parking_product,
    status: row.status,
    paymentStatus: row.payment_status,
    financiallyPaid: row.payment_status === 'PAID' || Boolean(row.payment_confirmed_at),
    demo: row.payment_status === 'DEMO_BYPASSED',
    subscriptionStatus: row.subscription_status,
    startsAt: row.arrival_at,
    endsAt: row.departure_at,
    vehicle: {
      unitNumber: row.tractor_unit_number,
      licensePlate: row.license_plate,
      licensePlateState: row.license_plate_state,
      classification: row.category_code === 'BOBTAIL' ? 'Bobtail' : 'General'
    },
    parkingArea: row.category_name,
    monthlySpace: row.parking_product === 'MONTHLY' ? (row.assignment_public_label || row.assigned_spot_label || null) : null,
    price: priceSnapshot(row),
    billing: {
      nextPaymentAt: row.billing_period_end_at || nextMonthlyBillingAt,
      cancelAtPeriodEnd: Boolean(row.subscription_cancel_at_period_end),
      graceEndsAt: row.payment_grace_ends_at,
      cancellationAvailable: row.parking_product === 'MONTHLY' && row.payment_status === 'PAID'
        && Boolean(row.stripe_subscription_id) && !row.subscription_cancel_at_period_end,
      demoCancellationAvailable: row.payment_status === 'DEMO_BYPASSED'
        && ['CONFIRMED','CHECKED_IN'].includes(row.status)
    },
    documents: {
      DRIVER_LICENSE: row.license_verification_status ? {
        status: ['REPLACEMENT_REQUESTED','REJECTED'].includes(row.license_verification_status)
          ? 'REPLACEMENT_REQUESTED' : row.license_verification_status === 'APPROVED' ? 'APPROVED' : 'RECEIVED'
      } : null,
      INSURANCE: row.insurance_verification_status ? {
        status: ['REPLACEMENT_REQUESTED','REJECTED'].includes(row.insurance_verification_status)
          ? 'REPLACEMENT_REQUESTED' : row.insurance_verification_status === 'APPROVED' ? 'APPROVED' : 'RECEIVED'
      } : null
    }
  };
}

async function accountData(customerId) {
  const [customer, bookings, payments, vehicles, documentRows] = await Promise.all([
    pool.query('SELECT * FROM parking_customers WHERE id=$1', [customerId]),
    pool.query(`SELECT booking.*,location.timezone,category.name category_name,category.code category_code,price.snapshot,
        assignment.public_label assignment_public_label,
        license.verification_status license_verification_status,
        insurance.verification_status insurance_verification_status
      FROM parking_bookings booking
      JOIN parking_locations location ON location.id=booking.location_id
      JOIN parking_categories category ON category.id=booking.category_id
      LEFT JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
      LEFT JOIN LATERAL (
        SELECT spot.public_label FROM reservation_spot_assignments active
        JOIN parking_spots spot ON spot.id=active.parking_spot_id
        WHERE active.booking_id=booking.id AND active.released_at IS NULL ORDER BY active.id DESC LIMIT 1
      ) assignment ON true
      LEFT JOIN LATERAL (SELECT verification_status FROM parking_customer_documents
        WHERE booking_id=booking.id AND document_type='DRIVER_LICENSE'
          AND upload_status='UPLOADED' AND superseded_at IS NULL ORDER BY revision DESC,id DESC LIMIT 1) license ON true
      LEFT JOIN LATERAL (SELECT verification_status FROM parking_customer_documents
        WHERE booking_id=booking.id AND document_type IN ('INSURANCE','VEHICLE_CARRIER_INSURANCE')
          AND upload_status='UPLOADED' AND superseded_at IS NULL ORDER BY revision DESC,id DESC LIMIT 1) insurance ON true
      WHERE booking.customer_id=$1 ORDER BY booking.arrival_at DESC,booking.id DESC`, [customerId]),
    pool.query(`SELECT payment.public_id,payment.parking_product,payment.amount_cents,payment.currency,
        payment.status,payment.receipt_url,payment.paid_at,payment.created_at,booking.reservation_number
      FROM parking_customer_payments payment JOIN parking_bookings booking ON booking.id=payment.booking_id
      WHERE payment.customer_id=$1 ORDER BY COALESCE(payment.paid_at,payment.created_at) DESC,payment.id DESC`, [customerId]),
    pool.query(`SELECT public_id,unit_number,license_plate,license_plate_state,vehicle_classification,
        active,last_used_at FROM parking_customer_vehicles WHERE customer_id=$1 ORDER BY active DESC,last_used_at DESC NULLS LAST,id DESC`, [customerId]),
    pool.query(`SELECT document.document_type,document.verification_status,
        document.uploaded_at,booking.reservation_number
      FROM parking_customer_documents document JOIN parking_bookings booking ON booking.id=document.booking_id
      WHERE booking.customer_id=$1 AND document.upload_status='UPLOADED' AND document.superseded_at IS NULL
      ORDER BY document.created_at DESC`, [customerId])
  ]);
  const now = Date.now();
  const eligibleRows = bookings.rows.filter(row => ['PAID','DEMO_BYPASSED'].includes(row.payment_status) || row.payment_confirmed_at
    || ['REFUNDED','PAST_DUE','PAYMENT_ACTION_REQUIRED'].includes(row.payment_status)
    || (row.payment_status === 'NOT_REQUIRED' && ['CONFIRMED','CHECKED_IN','CHECKED_OUT','COMPLETED'].includes(row.status)));
  const views = eligibleRows.map(reservationView);
  const current = views.filter(item => ['CONFIRMED','CHECKED_IN'].includes(item.status)
    && (item.parkingProduct === 'MONTHLY' ? !item.endsAt && !['CANCELED','ENDED'].includes(String(item.subscriptionStatus || '').toUpperCase())
      : new Date(item.startsAt).getTime() <= now && new Date(item.endsAt).getTime() > now));
  const upcoming = views.filter(item => item.status === 'CONFIRMED' && new Date(item.startsAt).getTime() > now);
  const currentKeys = new Set([...current, ...upcoming].map(item => item.reservationNumber));
  const past = views.filter(item => !currentKeys.has(item.reservationNumber));
  return {
    customer: auth.customerView(customer.rows[0]),
    reservations: { current, upcoming, past },
    payments: payments.rows.map(row => ({
      id: row.public_id,
      reservationNumber: row.reservation_number,
      parkingProduct: row.parking_product,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      status: row.status,
      paidAt: row.paid_at,
      createdAt: row.created_at,
      receiptAvailable: Boolean(row.receipt_url)
    })),
    vehicles: vehicles.rows.map(row => ({
      id: row.public_id, unitNumber: row.unit_number, licensePlate: row.license_plate,
      licensePlateState: row.license_plate_state, classification: row.vehicle_classification,
      active: row.active, lastUsedAt: row.last_used_at
    })),
    documents: documentRows.rows.map(row => ({
      reservationNumber: row.reservation_number,
      type: customerDocuments.canonicalType(row.document_type),
      status: ['REPLACEMENT_REQUESTED','REJECTED'].includes(row.verification_status)
        ? 'REPLACEMENT_REQUESTED' : row.verification_status === 'APPROVED' ? 'APPROVED' : 'RECEIVED',
      receivedAt: row.uploaded_at
    })),
    capabilities: {
      billingPortal: stripeGateway.billingPortalConfigured() && Boolean(customer.rows[0]?.stripe_customer_id)
    }
  };
}

router.get('/overview', async (req, res, next) => {
  try { res.json(await accountData(req.customer.id)); } catch (error) { next(error); }
});

router.patch('/profile', auth.csrf, async (req, res, next) => {
  try {
    if (req.body.phone !== undefined || req.body.email !== undefined) {
      throw apiError('CONTACT_REVERIFICATION_REQUIRED', 'Phone and email changes require identity reverification or staff-assisted recovery.', 409);
    }
    const firstName = cleanText(req.body.firstName, 80, 'First name', true);
    const lastName = cleanText(req.body.lastName, 80, 'Last name', true);
    const updated = (await pool.query(`UPDATE parking_customers SET first_name=$2,last_name=$3
      WHERE id=$1 RETURNING *`, [req.customer.id, firstName, lastName])).rows[0];
    res.json({ customer: auth.customerView(updated) });
  } catch (error) { next(error); }
});

function vehicleInput(body) {
  const classification = String(body.classification || '').toUpperCase();
  if (!['BOBTAIL','GENERAL'].includes(classification)) throw apiError('VALIDATION_ERROR', 'Choose Bobtail or General');
  return {
    unit: cleanText(body.unitNumber, 80, 'Unit number', true),
    plate: cleanText(body.licensePlate, 30, 'License plate', true).toUpperCase(),
    state: cleanText(body.licensePlateState, 40, 'License plate state', true).toUpperCase(),
    classification
  };
}

router.post('/vehicles', auth.csrf, async (req, res, next) => {
  try {
    const input = vehicleInput(req.body);
    const row = (await pool.query(`INSERT INTO parking_customer_vehicles(
        public_id,customer_id,unit_number,license_plate,license_plate_state,vehicle_classification)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [
      `veh_${token(24)}`, req.customer.id, input.unit, input.plate, input.state, input.classification
    ])).rows[0];
    res.status(201).json({ vehicle: { id: row.public_id } });
  } catch (error) {
    if (error.code === '23505') return next(apiError('VEHICLE_ALREADY_EXISTS', 'This vehicle is already in My Parking.', 409));
    next(error);
  }
});

router.patch('/vehicles/:vehicleId', auth.csrf, async (req, res, next) => {
  try {
    const input = vehicleInput(req.body);
    const row = (await pool.query(`UPDATE parking_customer_vehicles SET
        unit_number=$3,license_plate=$4,license_plate_state=$5,vehicle_classification=$6,active=true
      WHERE public_id=$1 AND customer_id=$2 RETURNING public_id`, [
      req.params.vehicleId, req.customer.id, input.unit, input.plate, input.state, input.classification
    ])).rows[0];
    if (!row) throw apiError('VEHICLE_NOT_FOUND', 'Vehicle not found', 404);
    res.json({ vehicle: { id: row.public_id } });
  } catch (error) {
    if (error.code === '23505') return next(apiError('VEHICLE_ALREADY_EXISTS', 'This vehicle is already in My Parking.', 409));
    next(error);
  }
});

router.delete('/vehicles/:vehicleId', auth.csrf, async (req, res, next) => {
  try {
    const result = await pool.query(`UPDATE parking_customer_vehicles SET active=false
      WHERE public_id=$1 AND customer_id=$2 RETURNING public_id`, [req.params.vehicleId, req.customer.id]);
    if (!result.rowCount) throw apiError('VEHICLE_NOT_FOUND', 'Vehicle not found', 404);
    res.status(204).end();
  } catch (error) { next(error); }
});

router.post('/claims', auth.csrf, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const number = String(req.body.reservationNumber || '').trim().toUpperCase();
    const credential = String(req.body.lookupCredential || '');
    await client.query('BEGIN');
    const booking = (await client.query('SELECT * FROM parking_bookings WHERE reservation_number=$1 FOR UPDATE', [number])).rows[0];
    if (!booking || !(await bcrypt.compare(credential, booking.lookup_credential_hash))) {
      throw apiError('BOOKING_NOT_FOUND', 'Reservation not found', 404);
    }
    if (booking.customer_id && Number(booking.customer_id) !== Number(req.customer.id)) {
      throw apiError('RESERVATION_ACCOUNT_CONFLICT', 'This reservation is already protected by another customer account.', 409);
    }
    const phoneMatches = req.customer.phone_verified_at
      && identity.normalizePhone(booking.mobile_phone) === req.customer.normalized_phone;
    const emailMatches = req.customer.email_verified_at
      && identity.normalizeEmail(booking.email) === req.customer.normalized_email;
    if (!phoneMatches && !emailMatches) {
      throw apiError('RESERVATION_IDENTITY_MISMATCH', 'The verified My Parking contact does not match this reservation.', 403);
    }
    await client.query('UPDATE parking_bookings SET customer_id=$2 WHERE id=$1 AND customer_id IS NULL', [booking.id, req.customer.id]);
    await client.query('COMMIT');
    res.json({ claimed: true, reservationNumber: booking.reservation_number });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/billing/portal', auth.csrf, async (req, res, next) => {
  try {
    if (!req.customer.stripe_customer_id) throw apiError('BILLING_PORTAL_NOT_AVAILABLE', 'Billing management is not available for this account.', 409);
    const monthly = await pool.query(`SELECT 1 FROM parking_bookings WHERE customer_id=$1
      AND parking_product='MONTHLY' AND payment_confirmed_at IS NOT NULL LIMIT 1`, [req.customer.id]);
    if (!monthly.rowCount) throw apiError('BILLING_PORTAL_NOT_AVAILABLE', 'Billing management is available for Monthly parking customers.', 409);
    const session = await stripeGateway.createPortalSession({
      customer: req.customer.stripe_customer_id,
      return_url: `${config.customerAppUrl}/#my-parking`
    }, `parkingops-customer-portal:${req.customer.id}:${Date.now().toString().slice(0, -4)}`);
    res.json({ portal: { url: session.url, temporary: true } });
  } catch (error) { next(error); }
});

router.post('/reservations/:reservationNumber/cancel-monthly', auth.csrf, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const booking = (await client.query(`SELECT * FROM parking_bookings
      WHERE reservation_number=$1 AND customer_id=$2 FOR UPDATE`, [
      String(req.params.reservationNumber || '').trim().toUpperCase(), req.customer.id
    ])).rows[0];
    if (!booking || booking.parking_product !== 'MONTHLY') throw apiError('RESERVATION_NOT_FOUND', 'Monthly reservation not found', 404);
    if (!booking.stripe_subscription_id || booking.payment_status !== 'PAID') {
      throw apiError('MONTHLY_CANCELLATION_NOT_AVAILABLE', 'This Monthly reservation is not eligible for online cancellation.', 409);
    }
    if (booking.subscription_cancel_at_period_end) {
      await client.query('COMMIT');
      return res.json({ reservationNumber: booking.reservation_number, cancelAtPeriodEnd: true,
        parkingEndsAt: booking.billing_period_end_at, idempotent: true });
    }
    const subscription = await stripeGateway.scheduleSubscriptionCancellation(booking.stripe_subscription_id,
      `parkingops-monthly-cancel:${booking.id}`);
    const periodEndSeconds = Number(subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end);
    const parkingEndsAt = Number.isFinite(periodEndSeconds) && periodEndSeconds > 0
      ? new Date(periodEndSeconds * 1000).toISOString() : booking.billing_period_end_at;
    await client.query(`UPDATE parking_bookings SET subscription_cancel_at_period_end=true,
      billing_period_end_at=COALESCE($2,billing_period_end_at),updated_at=now(),version=version+1 WHERE id=$1`,
    [booking.id, parkingEndsAt]);
    await notifications.enqueueForBooking(client, booking, 'CANCELLATION_CONFIRMED', { parkingEndsAt, endOfTerm: true });
    await client.query('COMMIT');
    res.json({ reservationNumber: booking.reservation_number, cancelAtPeriodEnd: true, parkingEndsAt });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/reservations/:reservationNumber/cancel-demo', auth.csrf, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const booking = (await client.query(`SELECT * FROM parking_bookings
      WHERE reservation_number=$1 AND customer_id=$2 FOR UPDATE`, [
      String(req.params.reservationNumber || '').trim().toUpperCase(), req.customer.id
    ])).rows[0];
    if (!booking) throw apiError('RESERVATION_NOT_FOUND', 'Demo reservation not found.', 404);
    const cancelled = await demoPaymentBypass.cancelDemoReservation(client, booking);
    await client.query('COMMIT');
    res.json({ reservationNumber: cancelled.booking.reservation_number,
      status: cancelled.booking.status, paymentStatus: cancelled.booking.payment_status,
      financiallyPaid: false, idempotent: cancelled.idempotent });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/payments/:paymentId/receipt', auth.csrf, async (req, res, next) => {
  try {
    const row = (await pool.query(`SELECT receipt_url FROM parking_customer_payments
      WHERE public_id=$1 AND customer_id=$2 AND status='PAID'`, [req.params.paymentId, req.customer.id])).rows[0];
    if (!row || !row.receipt_url) throw apiError('RECEIPT_NOT_AVAILABLE', 'A hosted receipt is not available for this payment.', 404);
    res.json({ receipt: { url: row.receipt_url, temporary: true } });
  } catch (error) { next(error); }
});

router.post('/reservations/:reservationNumber/documents/:documentType/upload', auth.csrf, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const booking = (await client.query(`SELECT * FROM parking_bookings
      WHERE reservation_number=$1 AND customer_id=$2 FOR UPDATE`, [
      String(req.params.reservationNumber || '').trim().toUpperCase(), req.customer.id
    ])).rows[0];
    if (!booking || !(['PAID','DEMO_BYPASSED'].includes(booking.payment_status) || booking.payment_confirmed_at
        || (booking.payment_status === 'NOT_REQUIRED' && ['CONFIRMED','CHECKED_IN','CHECKED_OUT','COMPLETED'].includes(booking.status)))) {
      throw apiError('RESERVATION_NOT_FOUND', 'An eligible reservation was not found in My Parking.', 404);
    }
    const started = await customerDocuments.startUpload(client, {
      bookingId: booking.id,
      documentType: req.params.documentType,
      filename: req.body.filename,
      mimeType: req.body.mimeType,
      sizeBytes: req.body.sizeBytes
    });
    await client.query('COMMIT');
    res.status(201).json({
      document: { type: customerDocuments.canonicalType(started.document.document_type), uploadStatus: started.document.upload_status },
      upload: { ...started.signed, token: started.uploadToken, expiresAt: started.uploadExpiresAt }
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

async function completeCustomerDocument(req, res, next, documentPublicId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pending = (await client.query(`SELECT document.booking_id FROM parking_customer_documents document
      JOIN parking_bookings booking ON booking.id=document.booking_id
      WHERE document.upload_token_hash=$1 AND booking.customer_id=$2
        ${documentPublicId ? 'AND document.public_id=$3' : ''}
      FOR UPDATE OF document`, documentPublicId
      ? [digest(String(req.body.uploadToken || '')), req.customer.id, documentPublicId]
      : [digest(String(req.body.uploadToken || '')), req.customer.id])).rows[0];
    if (!pending) throw apiError('DOCUMENT_NOT_FOUND', 'Document upload not found.', 404);
    const completed = await customerDocuments.completeUpload(client, {
      bookingId: pending.booking_id,
      uploadToken: req.body.uploadToken,
      documentPublicId
    });
    await client.query('COMMIT');
    res.json({ document: {
      type: customerDocuments.canonicalType(completed.document.document_type),
      uploadStatus: completed.document.upload_status,
      status: completed.document.verification_status === 'APPROVED' ? 'APPROVED' : 'RECEIVED'
    } });
  } catch (error) {
    if (error.documentRejectionPersisted) await client.query('COMMIT').catch(() => {});
    else await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
}

router.post('/documents/complete', auth.csrf, (req, res, next) => completeCustomerDocument(req, res, next));
// Completion-only compatibility for a customer page that was already open
// during deploy. There is intentionally no customer document read route.
router.post('/documents/:documentId/complete', auth.csrf,
  (req, res, next) => completeCustomerDocument(req, res, next, req.params.documentId));

module.exports = router;
