const config = require('../config');
const { monthlyOccupancyEnd } = require('./bookingPolicy');
const customerLedger = require('./customerLedger');
const { apiError, token, digest } = require('../utils');
const { selectExactSpot, assignSelectedExactSpot, currentAssignment, releaseCurrentAssignment } = require('./exactSpaceService');
const { assertFinalBookingAvailability } = require('./parkingService');
const { activateCustomerFromBooking } = require('./customerIdentity');
const notifications = require('./customerNotifications');

function assertEnabled() {
  if (!config.demoPaymentBypass.enabled) {
    throw apiError('DEMO_PAYMENT_BYPASS_DISABLED', 'Demo payment authorization is unavailable.', 404);
  }
}

function validPrice(snapshot) {
  const amount = Number(snapshot?.totalCents);
  return Number.isSafeInteger(amount) && amount >= 0 && String(snapshot?.currency || 'USD').toUpperCase() === 'USD';
}

function safeGrantView(row) {
  return {
    id: row.grant_public_id,
    expiresAt: row.grant_expires_at,
    reservationNumber: row.reservation_number,
    parkingProduct: row.parking_product,
    reservationStatus: row.status,
    paymentStatus: row.payment_status,
    price: {
      amountCents: Number(row.price_snapshot?.totalCents),
      currency: String(row.price_snapshot?.currency || 'USD').toUpperCase()
    },
    selectedPosition: row.assigned_spot_label || row.quote_spot_label || null,
    financiallyPaid: false,
    reason: 'DEMO_QA'
  };
}

async function bookingForIssue(client, bookingId) {
  const booking = (await client.query(`SELECT booking.*,price.snapshot price_snapshot,
      assignment.parking_spot_id assigned_parking_spot_id
    FROM parking_bookings booking
    JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
    LEFT JOIN LATERAL (SELECT parking_spot_id FROM reservation_spot_assignments
      WHERE booking_id=booking.id AND released_at IS NULL ORDER BY id DESC LIMIT 1) assignment ON true
    WHERE booking.id=$1
    FOR UPDATE OF booking`, [bookingId])).rows[0];
  if (!booking) return null;
  const quote = (await client.query(`SELECT id quote_id,parking_spot_id,hold_status,hold_released_at,
      consumed_booking_id,COALESCE(checkout_hold_expires_at,expires_at) quote_expires_at
    FROM parking_public_quotes WHERE checkout_booking_id=$1 FOR UPDATE`, [booking.id])).rows[0] || {};
  return { ...booking, ...quote };
}

async function issueAuthorization(client, { bookingId, adminUserId = null, initiator = 'ADMIN' }) {
  assertEnabled();
  const booking = await bookingForIssue(client, bookingId);
  if (!booking) throw apiError('DEMO_RESERVATION_NOT_FOUND', 'The reservation is unavailable for demo authorization.', 404);
  if (!booking.customer_id || booking.status !== 'PENDING' || booking.payment_status !== 'DRAFT') {
    throw apiError('DEMO_RESERVATION_NOT_ELIGIBLE', 'Only a pending draft reservation can receive demo authorization.', 409);
  }
  if (booking.stripe_checkout_session_id || booking.stripe_payment_intent_id || booking.stripe_subscription_id) {
    throw apiError('DEMO_STRIPE_STATE_CONFLICT', 'A reservation that has entered Stripe cannot use demo authorization.', 409);
  }
  if (!validPrice(booking.price_snapshot)) {
    throw apiError('DEMO_PRICE_INVALID', 'The reservation does not have a valid authoritative price snapshot.', 409);
  }
  if (booking.booking_source !== 'ADMIN_DESK' && !booking.quote_id) {
    throw apiError('DEMO_RESERVATION_NOT_ELIGIBLE', 'The public reservation is not bound to an authoritative quote.', 409);
  }
  const operationalExpiry = booking.quote_expires_at || booking.pending_expires_at;
  if ((booking.quote_id && (booking.hold_status !== 'ACTIVE' || booking.hold_released_at))
      || !operationalExpiry || new Date(operationalExpiry).getTime() <= Date.now()) {
    throw apiError('DEMO_QUOTE_EXPIRED', 'The reservation price or inventory hold has expired.', 409);
  }
  const expiresAt = new Date(Math.min(
    Date.now() + config.demoPaymentBypass.ttlSeconds * 1000,
    new Date(operationalExpiry).getTime()
  ));
  if (expiresAt.getTime() <= Date.now() + 1000) throw apiError('DEMO_QUOTE_EXPIRED', 'The reservation hold expires too soon.', 409);

  await client.query(`UPDATE parking_demo_payment_grants SET invalidated_at=now()
    WHERE booking_id=$1 AND used_at IS NULL AND invalidated_at IS NULL`, [booking.id]);
  const rawToken = token(32);
  const publicId = `demo_${token(24)}`;
  const grant = (await client.query(`INSERT INTO parking_demo_payment_grants(
      public_id,token_hash,booking_id,customer_id,created_by_admin_user_id,initiator,price_snapshot,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id,public_id,expires_at`, [
    publicId, digest(rawToken), booking.id, booking.customer_id, adminUserId,
    initiator, JSON.stringify(booking.price_snapshot), expiresAt.toISOString()
  ])).rows[0];
  await client.query(`INSERT INTO parking_audit_events(admin_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,'DEMO_PAYMENT_AUTHORIZATION_CREATED','booking',$2,$3)`, [
    adminUserId, String(booking.id), JSON.stringify({
      grantId: grant.public_id, customerId: Number(booking.customer_id), reason: 'DEMO_QA',
      expiresAt: grant.expires_at, priceSnapshot: booking.price_snapshot
    })
  ]);
  return {
    token: rawToken,
    grant: {
      id: grant.public_id,
      expiresAt: grant.expires_at,
      reservationNumber: booking.reservation_number,
      amountCents: Number(booking.price_snapshot.totalCents),
      financiallyPaid: false
    },
    url: `${config.customerAppUrl}/#demo-payment?token=${encodeURIComponent(rawToken)}`
  };
}

async function grantForToken(client, rawToken, { lock = false } = {}) {
  const value = String(rawToken || '');
  if (value.length < 32 || value.length > 200) throw apiError('DEMO_AUTHORIZATION_INVALID', 'Demo authorization is invalid.', 404);
  const result = await client.query(`SELECT demo_grant.id grant_id,demo_grant.public_id grant_public_id,
      demo_grant.booking_id grant_booking_id,demo_grant.customer_id grant_customer_id,
      demo_grant.created_by_admin_user_id grant_created_by_admin_user_id,
      demo_grant.expires_at grant_expires_at,demo_grant.used_at grant_used_at,
      demo_grant.invalidated_at grant_invalidated_at,demo_grant.completed_at grant_completed_at,
      demo_grant.price_snapshot grant_price_snapshot,
      booking.*,price.snapshot price_snapshot,quote.id quote_id,quote.parking_spot_id,
      quote.hold_status,quote.hold_released_at,quote.consumed_booking_id,
      COALESCE(quote.checkout_hold_expires_at,quote.expires_at) quote_expires_at,
      location.turnaround_buffer_minutes,location.timezone,category.code category_code,
      COALESCE(quote_spot.public_label,assigned_spot.public_label) quote_spot_label,
      assignment.parking_spot_id assigned_parking_spot_id,
      (demo_grant.price_snapshot=price.snapshot) price_matches
    FROM parking_demo_payment_grants demo_grant
    JOIN parking_bookings booking ON booking.id=demo_grant.booking_id
    JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
    LEFT JOIN parking_public_quotes quote ON quote.checkout_booking_id=booking.id
    JOIN parking_locations location ON location.id=booking.location_id
    JOIN parking_categories category ON category.id=booking.category_id
    LEFT JOIN parking_spots quote_spot ON quote_spot.id=quote.parking_spot_id
    LEFT JOIN LATERAL (SELECT parking_spot_id FROM reservation_spot_assignments
      WHERE booking_id=booking.id AND released_at IS NULL ORDER BY id DESC LIMIT 1) assignment ON true
    LEFT JOIN parking_spots assigned_spot ON assigned_spot.id=assignment.parking_spot_id
    WHERE demo_grant.token_hash=$1
    ${lock ? 'FOR UPDATE OF demo_grant,booking' : ''}`, [digest(value)]);
  if (!result.rowCount) throw apiError('DEMO_AUTHORIZATION_INVALID', 'Demo authorization is invalid.', 404);
  const row = result.rows[0];
  if (lock && row.quote_id) {
    const quote = (await client.query(`SELECT id quote_id,parking_spot_id,hold_status,hold_released_at,
        consumed_booking_id,COALESCE(checkout_hold_expires_at,expires_at) quote_expires_at
      FROM parking_public_quotes WHERE id=$1 FOR UPDATE`, [row.quote_id])).rows[0];
    return { ...row, ...quote };
  }
  return row;
}

function assertUsable(row) {
  if (row.grant_used_at || row.grant_completed_at) {
    throw apiError('DEMO_AUTHORIZATION_USED', 'Demo authorization has already been used.', 409);
  }
  if (row.grant_invalidated_at) throw apiError('DEMO_AUTHORIZATION_INVALID', 'Demo authorization is invalid.', 404);
  if (new Date(row.grant_expires_at).getTime() <= Date.now()) {
    throw apiError('DEMO_AUTHORIZATION_EXPIRED', 'Demo authorization has expired.', 410);
  }
  if (Number(row.grant_booking_id) !== Number(row.id)
      || Number(row.grant_customer_id) !== Number(row.customer_id)) {
    throw apiError('DEMO_AUTHORIZATION_BINDING_INVALID', 'Demo authorization binding is invalid.', 403);
  }
  if (!row.price_matches || !validPrice(row.price_snapshot)) {
    throw apiError('DEMO_PRICE_INVALID', 'The authoritative price snapshot no longer matches authorization.', 409);
  }
}

async function authorizationStatus(client, rawToken) {
  assertEnabled();
  const row = await grantForToken(client, rawToken);
  assertUsable(row);
  if (row.status !== 'PENDING' || row.payment_status !== 'DRAFT') {
    throw apiError('DEMO_RESERVATION_NOT_ELIGIBLE', 'This reservation cannot use demo authorization.', 409);
  }
  return safeGrantView(row);
}

async function completeAuthorization(client, rawToken) {
  assertEnabled();
  const booking = await grantForToken(client, rawToken, { lock: true });
  assertUsable(booking);
  if (booking.status !== 'PENDING' || booking.payment_status !== 'DRAFT') {
    throw apiError('DEMO_RESERVATION_NOT_ELIGIBLE', 'This reservation cannot use demo authorization.', 409);
  }
  if (booking.stripe_checkout_session_id || booking.stripe_payment_intent_id
      || booking.stripe_subscription_id || booking.stripe_latest_invoice_id) {
    throw apiError('DEMO_STRIPE_STATE_CONFLICT', 'A reservation that has entered Stripe cannot use demo authorization.', 409);
  }
  if (booking.booking_source !== 'ADMIN_DESK' && !booking.quote_id) {
    throw apiError('DEMO_RESERVATION_NOT_ELIGIBLE', 'The public reservation is not bound to an authoritative quote.', 409);
  }
  const operationalExpiry = booking.quote_expires_at || booking.pending_expires_at;
  if ((booking.quote_id && (booking.hold_status !== 'ACTIVE' || booking.hold_released_at || booking.consumed_booking_id))
      || !operationalExpiry || new Date(operationalExpiry).getTime() <= Date.now()) {
    throw apiError('DEMO_QUOTE_EXPIRED', 'The reservation price or inventory hold has expired.', 409);
  }

  const slot = await assertFinalBookingAvailability(client, booking);
  if (booking.parking_product === 'MONTHLY') {
    const selectedSpotId = booking.parking_spot_id || booking.requested_parking_spot_id || booking.assigned_parking_spot_id;
    if (booking.assignment_mode_snapshot !== 'CUSTOMER_SELECTED_SPOT' || !selectedSpotId) {
      throw apiError('MONTHLY_POSITION_REQUIRED', 'Demo Monthly parking requires the authorized selected position.', 409);
    }
    const existing = await currentAssignment(client, booking.id, { lock: true });
    if (!existing) {
      const spot = await selectExactSpot(client, {
        slot,
        arrival: booking.arrival_at,
        departure: booking.departure_at || monthlyOccupancyEnd(),
        preferredSpotId: selectedSpotId,
        excludeQuoteId: booking.quote_id
      });
      await assignSelectedExactSpot(client, {
        booking,
        slot,
        spot,
        source: 'CUSTOMER_SELECTED',
        reason: 'Demo QA authorization consumed'
      });
    }
  } else if (!['DAILY','WEEKLY'].includes(booking.parking_product)
      || booking.assignment_mode_snapshot !== 'ZONE_CAPACITY' || booking.parking_spot_id) {
    throw apiError('DEMO_ASSIGNMENT_INVALID', 'Demo Daily and Weekly parking must use area capacity.', 409);
  }

  const updated = (await client.query(`UPDATE parking_bookings SET
      status='CONFIRMED',payment_status='DEMO_BYPASSED',payment_confirmed_at=NULL,
      subscription_status=CASE WHEN parking_product='MONTHLY' THEN 'DEMO_QA' ELSE subscription_status END,
      pending_expires_at=NULL,version=version+1,updated_at=now()
    WHERE id=$1 AND status='PENDING' AND payment_status='DRAFT'
    RETURNING *`, [booking.id])).rows[0];
  if (!updated) throw apiError('DEMO_RESERVATION_NOT_ELIGIBLE', 'This reservation cannot use demo authorization.', 409);
  if (booking.quote_id) {
    await client.query(`UPDATE parking_public_quotes SET consumed_booking_id=$1,hold_status='CONSUMED'
      WHERE id=$2 AND consumed_booking_id IS NULL AND hold_status='ACTIVE'`, [booking.id, booking.quote_id]);
  }
  const consumed = await client.query(`UPDATE parking_demo_payment_grants
    SET used_at=clock_timestamp(),completed_at=clock_timestamp()
    WHERE id=$1 AND used_at IS NULL AND invalidated_at IS NULL RETURNING completed_at`, [booking.grant_id]);
  if (!consumed.rowCount) throw apiError('DEMO_AUTHORIZATION_USED', 'Demo authorization has already been used.', 409);
  await client.query(`INSERT INTO parking_booking_status_history(
      booking_id,previous_status,new_status,actor_type,reason,version)
    VALUES($1,$2,'CONFIRMED','SYSTEM','Demo QA authorization consumed',$3)`,
  [booking.id, booking.status, Number(updated.version)]);
  await client.query(`INSERT INTO parking_audit_events(admin_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,'DEMO_PAYMENT_BYPASS_COMPLETED','booking',$2,$3)`, [
    booking.grant_created_by_admin_user_id, String(booking.id), JSON.stringify({
      grantId: booking.grant_public_id, customerId: Number(booking.customer_id), reason: 'DEMO_QA',
      completedAt: consumed.rows[0].completed_at, priceSnapshot: booking.price_snapshot,
      financiallyPaid: false, stripeSideEffects: 0
    })
  ]);
  const activated = { ...booking, ...updated };
  if (activated.parking_product === 'MONTHLY') {
    await customerLedger.ensureMonthlyBillingPeriod(client, activated, {
      periodStart: new Date(activated.arrival_at).toISOString().slice(0, 7),
      amountDueCents: Number(activated.price_snapshot?.totalCents),
      source: 'BOOKING'
    });
  }
  await activateCustomerFromBooking(client, activated, null);
  await notifications.enqueueForBooking(client, activated, 'DEMO_RESERVATION_CONFIRMED');
  return {
    ...safeGrantView({ ...booking, ...updated }),
    reservationStatus: updated.status,
    paymentStatus: updated.payment_status,
    completedAt: consumed.rows[0].completed_at,
    financiallyPaid: false
  };
}

async function revokeUnused(client, { adminUserId }) {
  assertEnabled();
  const result = await client.query(`UPDATE parking_demo_payment_grants SET invalidated_at=now()
    WHERE used_at IS NULL AND invalidated_at IS NULL RETURNING public_id,booking_id`);
  for (const row of result.rows) {
    await client.query(`INSERT INTO parking_audit_events(admin_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'DEMO_PAYMENT_AUTHORIZATION_INVALIDATED','booking',$2,$3)`, [
      adminUserId, String(row.booking_id), JSON.stringify({ grantId: row.public_id, reason: 'DEMO_QA' })
    ]);
  }
  return result.rowCount;
}

async function expireUnused(client) {
  if (!config.demoPaymentBypass.enabled) return 0;
  const result = await client.query(`UPDATE parking_demo_payment_grants SET invalidated_at=now()
    WHERE used_at IS NULL AND invalidated_at IS NULL AND expires_at<=now()`);
  return result.rowCount;
}

async function cancelDemoReservation(client, booking) {
  if (!booking || booking.payment_status !== 'DEMO_BYPASSED') {
    throw apiError('DEMO_CANCELLATION_NOT_AVAILABLE', 'This reservation is not eligible for demo cancellation.', 409);
  }
  if (booking.status === 'CANCELLED') return { idempotent: true, booking };
  if (!['CONFIRMED','CHECKED_IN'].includes(booking.status)) {
    throw apiError('DEMO_CANCELLATION_NOT_AVAILABLE', 'This demo reservation cannot be cancelled online.', 409);
  }
  await releaseCurrentAssignment(client, booking.id, 'Demo QA reservation cancelled');
  const updated = (await client.query(`UPDATE parking_bookings SET status='CANCELLED',
      subscription_status=CASE WHEN parking_product='MONTHLY' THEN 'ENDED' ELSE subscription_status END,
      pending_expires_at=NULL,version=version+1,updated_at=now()
    WHERE id=$1 RETURNING *`, [booking.id])).rows[0];
  await client.query(`INSERT INTO parking_booking_status_history(
      booking_id,previous_status,new_status,actor_type,reason,version)
    VALUES($1,$2,'CANCELLED','CUSTOMER','Demo QA reservation cancelled',$3)`,
  [booking.id, booking.status, Number(updated.version)]);
  await client.query(`INSERT INTO parking_audit_events(action,entity_type,entity_id,metadata)
    VALUES('DEMO_RESERVATION_CANCELLED','booking',$1,$2)`, [
    String(booking.id), JSON.stringify({ reason: 'DEMO_QA', financiallyPaid: false, stripeRefund: false })
  ]);
  await notifications.enqueueForBooking(client, updated, 'CANCELLATION_CONFIRMED');
  return { idempotent: false, booking: updated };
}

module.exports = {
  assertEnabled,
  issueAuthorization,
  authorizationStatus,
  completeAuthorization,
  revokeUnused,
  expireUnused,
  cancelDemoReservation
};
