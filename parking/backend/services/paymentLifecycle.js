const config = require('../config');
const { apiError } = require('../utils');
const { selectExactSpot, assignSelectedExactSpot, currentAssignment, releaseCurrentAssignment } = require('./exactSpaceService');
const { activateCustomerFromBooking, recordPayment } = require('./customerIdentity');
const { monthlyOccupancyEnd } = require('./bookingPolicy');
const { assertFinalBookingAvailability } = require('./parkingService');
const { isOpenEndedWeekly } = require('./weeklyParking');
const notifications = require('./customerNotifications');

function recurringParking(booking) {
  return booking?.parking_product === 'MONTHLY' || isOpenEndedWeekly(booking);
}

function stripeId(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id || null;
}

function unixTime(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function metadataBookingId(object) {
  const candidates = [
    object?.metadata,
    object?.subscription_details?.metadata,
    object?.parent?.subscription_details?.metadata,
    object?.lines?.data?.[0]?.metadata
  ];
  for (const metadata of candidates) {
    const value = Number(metadata?.parking_booking_id);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

async function lockedPaymentBooking(client, object) {
  const sessionId = object?.object === 'checkout.session' ? object.id : null;
  const subscriptionId = stripeId(object?.subscription || object?.parent?.subscription_details?.subscription);
  const bookingId = metadataBookingId(object);
  const result = await client.query(`SELECT booking.*,price.snapshot,quote.id quote_id,quote.parking_spot_id,
      quote.hold_status,quote.hold_released_at,COALESCE(quote.checkout_hold_expires_at,quote.expires_at) quote_expires_at,
      quote.assignment_mode quote_assignment_mode,
      quote.consumed_booking_id,location.turnaround_buffer_minutes,location.timezone,
      category.code category_code
    FROM parking_bookings booking
    JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
    LEFT JOIN parking_public_quotes quote ON quote.checkout_booking_id=booking.id
    JOIN parking_locations location ON location.id=booking.location_id
    JOIN parking_categories category ON category.id=booking.category_id
    WHERE ($1::bigint IS NOT NULL AND booking.id=$1)
       OR ($2::text IS NOT NULL AND booking.stripe_checkout_session_id=$2)
       OR ($3::text IS NOT NULL AND booking.stripe_subscription_id=$3)
    ORDER BY booking.id
    FOR UPDATE OF booking`, [bookingId, sessionId, subscriptionId]);
  const bookingIds = new Set(result.rows.map(row => String(row.id)));
  if (bookingIds.size > 1) {
    throw apiError('STRIPE_BINDING_MISMATCH', 'Stripe references do not identify one ParkingOps booking', 409);
  }
  return result.rows[0] || null;
}

function assertExpectedAmount(booking, amount, currency) {
  const expected = Number(booking.snapshot?.totalCents);
  if (!Number.isSafeInteger(expected) || expected < 0) throw apiError('PAYMENT_QUOTE_INVALID', 'The server price snapshot is invalid', 409);
  if (Number(amount) !== expected || String(currency || '').toLowerCase() !== config.stripe.currency) {
    throw apiError('STRIPE_AMOUNT_MISMATCH', 'Stripe payment does not match the authoritative ParkingOps quote', 409);
  }
}

async function activatePaidBooking(client, booking, references) {
  if (booking.payment_confirmed_at && booking.status === 'CONFIRMED') {
    await client.query(`UPDATE parking_bookings SET
      payment_status='PAID',subscription_status=CASE WHEN parking_product='MONTHLY' OR (parking_product='WEEKLY' AND departure_at IS NULL) THEN 'ACTIVE' ELSE subscription_status END,
      stripe_customer_id=COALESCE(stripe_customer_id,$2),
      stripe_payment_intent_id=COALESCE(stripe_payment_intent_id,$3),
      stripe_subscription_id=COALESCE(stripe_subscription_id,$4),
      stripe_latest_invoice_id=COALESCE($5,stripe_latest_invoice_id),
      billing_period_end_at=COALESCE($6,billing_period_end_at),payment_grace_ends_at=NULL,updated_at=now()
      WHERE id=$1`, [booking.id, references.customerId, references.paymentIntentId,
      references.subscriptionId, references.invoiceId, references.billingPeriodEndAt]);
    await activateCustomerFromBooking(client, booking, references.customerId);
    return false;
  }
  // A paid reservation that could not be allocated is intentionally left
  // non-operational for an employee to resolve; never retry into a different
  // space or turn it into an occupancy record.
  if (booking.payment_confirmed_at && booking.status === 'PENDING' && booking.payment_status === 'PAID') return false;
  const requiresPublicQuote = booking.booking_source !== 'ADMIN_DESK';
  if (requiresPublicQuote && (!booking.quote_id || booking.consumed_booking_id && Number(booking.consumed_booking_id) !== Number(booking.id))) {
    throw apiError('PAYMENT_BOOKING_INVALID', 'The payment is not bound to a valid ParkingOps quote', 409);
  }
  if (requiresPublicQuote && (booking.hold_status !== 'ACTIVE' || booking.hold_released_at
      || new Date(booking.quote_expires_at).getTime() <= Date.now())) {
    throw apiError('PAYMENT_HOLD_EXPIRED', 'The selected parking hold expired before payment could be activated', 409);
  }

  let slot;
  try {
    slot = await assertFinalBookingAvailability(client, booking);
    if (booking.parking_product === 'MONTHLY') {
      const requestedSpotId = booking.parking_spot_id || booking.requested_parking_spot_id;
      if (booking.assignment_mode_snapshot !== 'CUSTOMER_SELECTED_SPOT'
          || (requiresPublicQuote && booking.quote_assignment_mode !== 'CUSTOMER_SELECTED_SPOT')
          || !requestedSpotId) {
        throw apiError('MONTHLY_POSITION_REQUIRED', 'The Monthly payment is not bound to a selected parking space', 409);
      }
      const existing = await currentAssignment(client, booking.id, { lock: true });
      if (!existing) {
        const spot = await selectExactSpot(client, {
          slot,
          arrival: booking.arrival_at,
          departure: booking.departure_at || monthlyOccupancyEnd(),
          preferredSpotId: requestedSpotId,
          excludeQuoteId: booking.quote_id
        });
        await assignSelectedExactSpot(client, {
          booking,
          slot,
          spot,
          source: 'CUSTOMER_SELECTED',
          reason: 'First Stripe subscription payment verified'
        });
      }
    } else if (!['DAILY', 'WEEKLY'].includes(booking.parking_product) || booking.assignment_mode_snapshot !== 'ZONE_CAPACITY') {
      throw apiError('AREA_CAPACITY_EXACT_SPACE_FORBIDDEN', 'Daily and Weekly parking cannot create an exact-space assignment', 409);
    }
  } catch (error) {
    if (!['PARKING_ALLOCATION_UNAVAILABLE', 'MONTHLY_POSITION_UNAVAILABLE', 'QUOTED_SPACE_UNAVAILABLE', 'NO_EXACT_SPOT_AVAILABLE'].includes(error.code)) throw error;
    await client.query(`UPDATE parking_bookings SET payment_status='PAID',payment_confirmed_at=COALESCE(payment_confirmed_at,now()),
        stripe_customer_id=COALESCE(stripe_customer_id,$2),stripe_payment_intent_id=COALESCE(stripe_payment_intent_id,$3),
        stripe_subscription_id=COALESCE(stripe_subscription_id,$4),stripe_latest_invoice_id=COALESCE($5,stripe_latest_invoice_id),
        billing_period_end_at=COALESCE($6,billing_period_end_at),pending_expires_at=NULL,
        operational_notes=concat_ws(E'\\n',NULLIF(operational_notes,''),'Payment verified; parking allocation requires employee review.'),
        version=version+1,updated_at=now() WHERE id=$1`, [booking.id, references.customerId, references.paymentIntentId,
      references.subscriptionId, references.invoiceId, references.billingPeriodEndAt]);
    if (booking.quote_id) await client.query(`UPDATE parking_public_quotes SET consumed_booking_id=$1,hold_status='CONSUMED'
      WHERE id=$2 AND (consumed_booking_id IS NULL OR consumed_booking_id=$1)`, [booking.id, booking.quote_id]);
    return false;
  }

  const updated = await client.query(`UPDATE parking_bookings SET
      status='CONFIRMED',payment_status='PAID',payment_confirmed_at=COALESCE(payment_confirmed_at,now()),
      stripe_customer_id=COALESCE(stripe_customer_id,$2),
      stripe_payment_intent_id=COALESCE(stripe_payment_intent_id,$3),
      stripe_subscription_id=COALESCE(stripe_subscription_id,$4),
      stripe_latest_invoice_id=COALESCE($5,stripe_latest_invoice_id),
      subscription_status=CASE WHEN parking_product='MONTHLY' OR (parking_product='WEEKLY' AND departure_at IS NULL) THEN COALESCE($7,'ACTIVE') ELSE subscription_status END,
      billing_period_end_at=COALESCE($6,billing_period_end_at),payment_grace_ends_at=NULL,
      pending_expires_at=NULL,version=version+1,updated_at=now()
    WHERE id=$1 RETURNING *`, [booking.id, references.customerId, references.paymentIntentId,
    references.subscriptionId, references.invoiceId, references.billingPeriodEndAt, references.subscriptionStatus]);
  await client.query(`UPDATE parking_public_quotes SET consumed_booking_id=$1,hold_status='CONSUMED'
    WHERE id=$2 AND (consumed_booking_id IS NULL OR consumed_booking_id=$1)`, [booking.id, booking.quote_id]);
  if (booking.status !== 'CONFIRMED') {
    await client.query(`INSERT INTO parking_booking_status_history(
      booking_id,previous_status,new_status,actor_type,reason,version)
      VALUES($1,$2,'CONFIRMED','SYSTEM','Stripe payment verified',$3)`,
    [booking.id, booking.status, Number(updated.rows[0].version)]);
  }
  const activated = { ...booking, ...updated.rows[0] };
  await activateCustomerFromBooking(client, activated, references.customerId);
  await notifications.enqueueForBooking(client, activated, 'RESERVATION_CONFIRMED');
  return true;
}

async function checkoutPaid(client, session) {
  const booking = await lockedPaymentBooking(client, session);
  if (!booking) return;
  if (booking.stripe_checkout_session_id && booking.stripe_checkout_session_id !== session.id) {
    throw apiError('STRIPE_SESSION_MISMATCH', 'Stripe session does not match the ParkingOps booking', 409);
  }
  if (!['paid', 'no_payment_required'].includes(String(session.payment_status || ''))) return;
  assertExpectedAmount(booking, session.amount_total, session.currency);
  const subscriptionId = stripeId(session.subscription);
  if (recurringParking(booking) && !subscriptionId) {
    throw apiError('STRIPE_SUBSCRIPTION_REQUIRED', `${booking.parking_product === 'WEEKLY' ? 'Weekly' : 'Monthly'} Checkout did not create a subscription`, 409);
  }
  await activatePaidBooking(client, booking, {
    customerId: stripeId(session.customer),
    paymentIntentId: stripeId(session.payment_intent),
    subscriptionId,
    invoiceId: stripeId(session.invoice),
    subscriptionStatus: booking.parking_product === 'WEEKLY' ? 'TRIALING' : booking.parking_product === 'MONTHLY' ? 'ACTIVE' : null
  });
  if (booking.parking_product === 'DAILY' || (booking.parking_product === 'WEEKLY' && !isOpenEndedWeekly(booking))) {
    await recordPayment(client, booking, {
      processorPaymentId: stripeId(session.payment_intent) || session.id,
      amountCents: session.amount_total,
      currency: session.currency,
      status: 'PAID',
      paidAt: unixTime(session.created) || new Date().toISOString()
    });
  }
}

async function checkoutFailed(client, session, paymentStatus) {
  const booking = await lockedPaymentBooking(client, session);
  if (!booking || booking.payment_status === 'PAID') return;
  await client.query(`UPDATE parking_bookings SET payment_status=$2,status='EXPIRED',pending_expires_at=NULL,
      stripe_customer_id=COALESCE(stripe_customer_id,$3),updated_at=now(),version=version+1 WHERE id=$1`,
  [booking.id, paymentStatus, stripeId(session.customer)]);
  if (booking.quote_id) {
    await client.query(`UPDATE parking_public_quotes SET hold_status=CASE WHEN $2='EXPIRED' THEN 'EXPIRED' ELSE 'RELEASED' END,
      hold_released_at=COALESCE(hold_released_at,now())
      WHERE id=$1 AND consumed_booking_id IS NULL`, [booking.quote_id, paymentStatus]);
  }
  if (booking.status !== 'EXPIRED') {
    await client.query(`INSERT INTO parking_booking_status_history(
      booking_id,previous_status,new_status,actor_type,reason,version)
      SELECT id,$2,'EXPIRED','SYSTEM',$3,version FROM parking_bookings WHERE id=$1`,
    [booking.id, booking.status, paymentStatus === 'EXPIRED' ? 'Stripe Checkout expired' : 'Stripe payment failed']);
  }
}

async function invoicePaid(client, invoice) {
  const booking = await lockedPaymentBooking(client, invoice);
  if (!booking || !recurringParking(booking)) return;
  // The first invoice is bound to the authoritative quote. Later invoices may
  // legitimately contain Stripe-managed tax, credits, or prorations.
  if (!booking.payment_confirmed_at) assertExpectedAmount(booking, invoice.amount_paid, invoice.currency);
  // Checkout can confirm a new Monthly reservation before Stripe emits the
  // subscription's first invoice.paid event. Use our durable payment ledger,
  // rather than payment_confirmed_at, to distinguish that first invoice from a
  // real renewal and avoid sending a false renewal notification.
  const priorPaid = await client.query(`SELECT 1 FROM parking_customer_payments
    WHERE booking_id=$1 AND status='PAID' LIMIT 1`, [booking.id]);
  const firstInvoice = !priorPaid.rowCount;
  const firstPeriodEnd = firstInvoice ? booking.snapshot?.nextBillingAt : null;
  if (firstInvoice && (!firstPeriodEnd || !Number.isFinite(Date.parse(firstPeriodEnd)))) {
    throw apiError('PAYMENT_QUOTE_INVALID', 'The recurring billing snapshot has an invalid next billing date', 409);
  }
  await activatePaidBooking(client, booking, {
    customerId: stripeId(invoice.customer),
    subscriptionId: stripeId(invoice.subscription || invoice.parent?.subscription_details?.subscription),
    invoiceId: invoice.id,
    paymentIntentId: stripeId(invoice.payment_intent),
    billingPeriodEndAt: firstPeriodEnd || unixTime(invoice.lines?.data?.[0]?.period?.end),
    subscriptionStatus: 'ACTIVE'
  });
  await recordPayment(client, booking, {
    processorPaymentId: invoice.id,
    amountCents: invoice.amount_paid,
    currency: invoice.currency,
    status: 'PAID',
    receiptUrl: invoice.hosted_invoice_url || invoice.invoice_pdf,
    paidAt: unixTime(invoice.status_transitions?.paid_at || invoice.created) || new Date().toISOString(),
    billingPeriodStart: firstInvoice ? new Date(booking.arrival_at).toISOString() : unixTime(invoice.lines?.data?.[0]?.period?.start),
    amountDueCents: Number(invoice.amount_due ?? invoice.amount_paid)
  });
  if (priorPaid.rowCount && booking.parking_product === 'MONTHLY') await notifications.enqueueForBooking(client, booking, 'MONTHLY_RENEWED');
}

async function invoiceProblem(client, invoice, state) {
  const booking = await lockedPaymentBooking(client, invoice);
  if (!booking || !recurringParking(booking) || booking.payment_status === 'CANCELLED') return;
  const graceEnd = new Date(Date.now() + config.stripe.monthlyGraceDays * 86400000).toISOString();
  await client.query(`UPDATE parking_bookings SET payment_status=$2,subscription_status=$3,
      stripe_latest_invoice_id=$4,payment_grace_ends_at=COALESCE(payment_grace_ends_at,$5),updated_at=now(),version=version+1
    WHERE id=$1`, [booking.id, state, state === 'PAST_DUE' ? 'PAST_DUE' : 'PAYMENT_ACTION_REQUIRED', invoice.id, graceEnd]);
  await recordPayment(client, booking, {
    processorPaymentId: invoice.id,
    amountCents: Number(invoice.amount_due || 0),
    currency: invoice.currency || config.stripe.currency,
    status: 'FAILED',
    billingPeriodStart: unixTime(invoice.lines?.data?.[0]?.period?.start),
    amountDueCents: Number(invoice.amount_due || 0)
  });
  if (booking.parking_product === 'MONTHLY') await notifications.enqueueForBooking(client, booking, 'MONTHLY_PAYMENT_FAILED');
}

async function subscriptionChanged(client, subscription, deleted = false) {
  const booking = await lockedPaymentBooking(client, subscription);
  if (!booking || !recurringParking(booking)) return;
  const periodEnd = unixTime(subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end);
  const customerId = stripeId(subscription.customer);
  await client.query(`UPDATE parking_bookings SET stripe_customer_id=COALESCE(stripe_customer_id,$2),
      stripe_subscription_id=COALESCE(stripe_subscription_id,$3),subscription_status=$4,
      subscription_cancel_at_period_end=$5,billing_period_end_at=COALESCE($6,billing_period_end_at),updated_at=now()
    WHERE id=$1`, [booking.id, customerId, subscription.id,
    deleted ? 'CANCELED' : String(subscription.status || '').toUpperCase(),
    Boolean(subscription.cancel_at_period_end || deleted), periodEnd]);
  if (deleted && (!periodEnd || new Date(periodEnd).getTime() <= Date.now())) {
    await releaseEndedBooking(client, booking.id, 'Stripe subscription ended');
  }
}

async function releaseEndedBooking(client, bookingId, reason) {
  const row = (await client.query('SELECT * FROM parking_bookings WHERE id=$1 FOR UPDATE', [bookingId])).rows[0];
  if (!row || row.payment_status === 'CANCELLED') return;
  await releaseCurrentAssignment(client, row.id, reason);
  await client.query(`UPDATE parking_bookings SET status='CANCELLED',payment_status='CANCELLED',
    subscription_status='ENDED',departure_at=COALESCE(departure_at,
      GREATEST(COALESCE(billing_period_end_at,now()),arrival_at+interval '1 millisecond')),
    version=version+1,updated_at=now() WHERE id=$1`, [row.id]);
  if (row.status !== 'CANCELLED') {
    await client.query(`INSERT INTO parking_booking_status_history(
      booking_id,previous_status,new_status,actor_type,reason,version)
      SELECT id,$2,'CANCELLED','SYSTEM',$3,version FROM parking_bookings WHERE id=$1`, [row.id, row.status, reason]);
  }
  await notifications.enqueueForBooking(client, row, 'CANCELLATION_CONFIRMED');
}

async function releaseEndedSubscriptions(client) {
  const rows = await client.query(`SELECT id FROM parking_bookings
    WHERE (parking_product='MONTHLY' OR (parking_product='WEEKLY' AND departure_at IS NULL))
      AND payment_status IN ('PAST_DUE','PAYMENT_ACTION_REQUIRED','PAID')
      AND (
        (subscription_status IN ('CANCELED','ENDED') AND billing_period_end_at IS NOT NULL AND billing_period_end_at<=now())
        OR (payment_status IN ('PAST_DUE','PAYMENT_ACTION_REQUIRED') AND payment_grace_ends_at IS NOT NULL AND payment_grace_ends_at<=now())
      ) FOR UPDATE SKIP LOCKED`);
  for (const row of rows.rows) await releaseEndedBooking(client, row.id, 'Recurring billing coverage ended');
  return rows.rowCount;
}

async function processStripeEvent(client, event) {
  if (!event?.id || !event?.type || !event?.data?.object) throw apiError('STRIPE_EVENT_INVALID', 'Stripe event is invalid', 400);
  const inserted = await client.query(`INSERT INTO parking_stripe_events(
      stripe_event_id,event_type,stripe_created_at,livemode)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING stripe_event_id`,
  [event.id, event.type, unixTime(event.created), Boolean(event.livemode)]);
  if (!inserted.rowCount) return { duplicate: true };
  const object = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': await checkoutPaid(client, object); break;
    case 'checkout.session.expired': await checkoutFailed(client, object, 'EXPIRED'); break;
    case 'checkout.session.async_payment_failed': await checkoutFailed(client, object, 'FAILED'); break;
    case 'invoice.paid': await invoicePaid(client, object); break;
    case 'invoice.payment_failed': await invoiceProblem(client, object, 'PAST_DUE'); break;
    case 'invoice.payment_action_required': await invoiceProblem(client, object, 'PAYMENT_ACTION_REQUIRED'); break;
    case 'customer.subscription.updated': await subscriptionChanged(client, object, false); break;
    case 'customer.subscription.deleted': await subscriptionChanged(client, object, true); break;
    default: break;
  }
  const booking = await lockedPaymentBooking(client, object);
  if (booking) await client.query('UPDATE parking_stripe_events SET booking_id=$2 WHERE stripe_event_id=$1', [event.id, booking.id]);
  return { duplicate: false };
}

module.exports = { processStripeEvent, releaseEndedSubscriptions, metadataBookingId, assertExpectedAmount };
