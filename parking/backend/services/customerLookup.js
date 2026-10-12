const crypto = require('crypto');
const config = require('../config');
const { apiError, cleanText, email, phone, token, digest } = require('../utils');

const ELIGIBLE_BOOKING_SQL = `(booking.payment_status IN ('PAID','DEMO_BYPASSED') OR booking.payment_confirmed_at IS NOT NULL
  OR booking.payment_status IN ('REFUNDED','PAST_DUE','PAYMENT_ACTION_REQUIRED')
  OR (booking.payment_status='NOT_REQUIRED' AND booking.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT','COMPLETED')))`;

function genericLookupError(status = 404) {
  return apiError('PARKING_RECORD_NOT_FOUND', 'We could not find a matching parking record.', status);
}

function normalizedName(value) {
  const name = cleanText(value, 161, 'Name', true).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.split(' ').length < 2) throw genericLookupError();
  return name.toLocaleLowerCase('en-US');
}

function normalizedPlate(value) {
  const plate = cleanText(value, 30, 'License plate', true).normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (plate.length < 2) throw genericLookupError();
  return plate;
}

// Drivers find their parking with the email and mobile phone they booked with.
function normalizedIdentity(body = {}) {
  try {
    return { email: email(body.email), phone: phone(body.phone) };
  } catch (_) { throw genericLookupError(); }
}

function rowMatches(row, identity) {
  try {
    return email(row.email) === identity.email && phone(row.mobile_phone) === identity.phone;
  } catch (_) { return false; }
}

async function findMatchingBooking(client, body) {
  const identity = normalizedIdentity(body);
  const result = await client.query(`SELECT booking.*,category.code category_code,category.name category_name
    FROM parking_bookings booking
    JOIN parking_categories category ON category.id=booking.category_id
    WHERE lower(trim(booking.email))=$1 AND ${ELIGIBLE_BOOKING_SQL}
    ORDER BY
      CASE booking.status WHEN 'CHECKED_IN' THEN 0 WHEN 'CONFIRMED' THEN 1 WHEN 'CHECKED_OUT' THEN 2 ELSE 3 END,
      CASE WHEN booking.departure_at>now() THEN 0 ELSE 1 END,
      booking.arrival_at DESC,booking.id DESC
    LIMIT 100 FOR UPDATE OF booking`, [identity.email]);
  const matches = result.rows.filter(row => rowMatches(row, identity));
  if (!matches.length) throw genericLookupError();
  // A driver with several stays can say which one a document is for.
  const requested = String(body.reservationNumber || '').trim().toUpperCase();
  if (requested) {
    const chosen = matches.find(row => row.reservation_number === requested);
    if (!chosen) throw genericLookupError();
    return chosen;
  }
  const customerIds = new Set(matches.map(row => row.customer_id && String(row.customer_id)).filter(Boolean));
  if (customerIds.size > 1) throw genericLookupError();
  if (customerIds.size === 1) {
    const customerId = [...customerIds][0];
    return matches.find(row => String(row.customer_id || '') === customerId) || matches[0];
  }
  return matches[0];
}

function hmac(value) {
  return crypto.createHmac('sha256', config.customerLookup.pepper).update(String(value)).digest('hex');
}

function fingerprint(req) {
  return {
    ipHash: hmac(`lookup-ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`),
    userAgentHash: hmac(`lookup-ua:${String(req.get?.('user-agent') || '').slice(0, 500)}`)
  };
}

async function createGrant(client, req, booking, documentType = null) {
  const rawToken = token(32);
  const csrfToken = token(24);
  const request = fingerprint(req);
  const expiresAt = new Date(Date.now() + config.customerLookup.ttlSeconds * 1000).toISOString();
  const grant = (await client.query(`INSERT INTO parking_customer_lookup_grants(
      token_hash,csrf_hash,booking_id,document_type,requester_ip_hash,user_agent_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
    digest(rawToken), digest(csrfToken), booking.id, documentType,
    request.ipHash, request.userAgentHash, expiresAt
  ])).rows[0];
  return { grant, rawToken, csrfToken, expiresAt };
}

async function grantFromRequest(client, req, { lock = false } = {}) {
  const rawToken = String(req.cookies?.[config.customerLookup.cookieName] || '');
  if (!rawToken) throw genericLookupError(401);
  const userAgentHash = fingerprint(req).userAgentHash;
  const grant = (await client.query(`SELECT grant_row.*,booking.customer_id
    FROM parking_customer_lookup_grants grant_row
    JOIN parking_bookings booking ON booking.id=grant_row.booking_id
    WHERE grant_row.token_hash=$1 AND grant_row.user_agent_hash=$2
      AND grant_row.revoked_at IS NULL AND grant_row.expires_at>now()
    ${lock ? 'FOR UPDATE OF grant_row' : ''}`, [digest(rawToken), userAgentHash])).rows[0];
  if (!grant) throw genericLookupError(401);
  await client.query('UPDATE parking_customer_lookup_grants SET last_seen_at=now() WHERE id=$1', [grant.id]);
  return grant;
}

function safeDocumentStatus(status) {
  if (!status) return 'MISSING';
  return ['REPLACEMENT_REQUESTED','REJECTED'].includes(String(status).toUpperCase())
    ? 'REPLACEMENT_REQUESTED' : 'RECEIVED';
}

function reservationView(row) {
  const owed = row.owed_cents == null ? null : {
    balanceCents: Number(row.owed_cents),
    dueDate: row.owed_due_date || null,
    overdue: Boolean(row.owed_overdue),
    paidCents: Number(row.paid_cents || 0)
  };
  return {
    reservationNumber: row.reservation_number,
    parkingProduct: row.parking_product,
    status: row.status,
    paymentStatus: row.payment_status,
    financiallyPaid: row.payment_status === 'PAID' || Boolean(row.payment_confirmed_at),
    demo: row.payment_status === 'DEMO_BYPASSED',
    startsAt: row.arrival_at,
    endsAt: row.departure_at,
    space: row.assignment_public_label || row.assigned_spot_label || null,
    owed,
    parkingArea: row.category_name,
    vehicle: {
      unitNumber: row.tractor_unit_number,
      licensePlate: row.license_plate,
      licensePlateState: row.license_plate_state,
      classification: row.category_code === 'BOBTAIL' ? 'Bobtail' : 'General'
    },
    documents: {
      DRIVER_LICENSE: { status: safeDocumentStatus(row.license_verification_status) },
      INSURANCE: { status: safeDocumentStatus(row.insurance_verification_status) }
    }
  };
}

async function safeSummary(client, grant) {
  const selected = (await client.query('SELECT customer_id FROM parking_bookings WHERE id=$1', [grant.booking_id])).rows[0];
  if (!selected) throw genericLookupError(401);
  const bookings = await client.query(`SELECT booking.*,category.name category_name,category.code category_code,
      assignment.public_label assignment_public_label,
      license.verification_status license_verification_status,
      insurance.verification_status insurance_verification_status,
      owed.owed_cents,owed.paid_cents,owed.owed_due_date,owed.owed_overdue
    FROM parking_bookings booking
    JOIN parking_categories category ON category.id=booking.category_id
    LEFT JOIN LATERAL (
      SELECT sum(balance.balance_cents)::bigint owed_cents,sum(balance.paid_cents)::bigint paid_cents,
        min(balance.due_date) FILTER (WHERE balance.balance_cents>0) owed_due_date,
        bool_or(balance.status='OVERDUE') owed_overdue
      FROM parking_customer_billing_period_balances balance WHERE balance.booking_id=booking.id
    ) owed ON true
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
    WHERE ${selected.customer_id ? 'booking.customer_id=$1' : 'booking.id=$1'} AND ${ELIGIBLE_BOOKING_SQL}
    ORDER BY booking.arrival_at DESC,booking.id DESC`, [selected.customer_id || grant.booking_id]);
  const views = bookings.rows.map(reservationView);
  const now = Date.now();
  // Open-ended Monthly parking (no end date) stays current until it ends.
  const current = views.filter(item => ['CONFIRMED','CHECKED_IN'].includes(item.status)
    && new Date(item.startsAt).getTime() <= now && (!item.endsAt || new Date(item.endsAt).getTime() > now));
  const upcoming = views.filter(item => item.status === 'CONFIRMED' && new Date(item.startsAt).getTime() > now);
  const currentKeys = new Set([...current,...upcoming].map(item => item.reservationNumber));
  const past = views.filter(item => !currentKeys.has(item.reservationNumber));
  const bookingIds = bookings.rows.map(row => row.id);
  const payments = bookingIds.length ? await client.query(`SELECT payment.parking_product,payment.amount_cents,
      payment.currency,payment.status,payment.paid_at,payment.created_at,booking.reservation_number
    FROM parking_customer_payments payment JOIN parking_bookings booking ON booking.id=payment.booking_id
    WHERE payment.booking_id=ANY($1::bigint[]) ORDER BY COALESCE(payment.paid_at,payment.created_at) DESC,payment.id DESC`, [bookingIds])
    : { rows: [] };
  const upload = bookings.rows.find(row => Number(row.id) === Number(grant.booking_id));
  return {
    readOnly: true,
    reservations: { current, upcoming, past },
    payments: payments.rows.map(row => ({
      reservationNumber: row.reservation_number,
      parkingProduct: row.parking_product,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      status: row.status,
      paidAt: row.paid_at,
      createdAt: row.created_at
    })),
    uploadReservation: upload ? reservationView(upload) : null
  };
}

function validCsrf(req, grant) {
  const supplied = digest(String(req.get('x-csrf-token') || ''));
  const left = Buffer.from(supplied); const right = Buffer.from(String(grant.csrf_hash || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function rotateCsrf(client, grant) {
  const csrfToken = token(24);
  await client.query('UPDATE parking_customer_lookup_grants SET csrf_hash=$2,last_seen_at=now() WHERE id=$1',
    [grant.id, digest(csrfToken)]);
  return csrfToken;
}

module.exports = {
  ELIGIBLE_BOOKING_SQL, genericLookupError, normalizedName, normalizedPlate, normalizedIdentity,
  findMatchingBooking, createGrant, grantFromRequest, safeSummary, validCsrf, rotateCsrf
};
