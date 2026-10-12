const express = require('express');
const bcrypt = require('bcrypt');
const { DateTime } = require('luxon');
const pool = require('../db');
const config = require('../config');
const { requireAdmin, csrf, permit } = require('../auth');
const { apiError, cleanText, email, phone, token, digest, reservationNumber, locationInterval } = require('../utils');
const { availability, priceQuote, publicRateOfferForInventory } = require('../services/parkingService');
const { validateBookingPolicy, monthlyOccupancyEnd } = require('../services/bookingPolicy');
const { pendingExpiryAt, expirePendingBookings } = require('../services/bookingWorkflow');
const { selectExactSpot, currentAssignment, expireQuoteHolds } = require('../services/exactSpaceService');
const customerIdentity = require('../services/customerIdentity');
const customerDocuments = require('../services/customerDocuments');
const customerNotifications = require('../services/customerNotifications');
const stripeGateway = require('../services/stripeGateway');
const demoPaymentBypass = require('../services/demoPaymentBypass');
const { payOnSite, confirmOnSiteBooking, ensureOnSiteCharges } = require('../services/onSiteBooking');
const { isOpenEndedWeekly, weeklyCheckoutPlan } = require('../services/weeklyParking');

const router = express.Router();
router.use(requireAdmin);
const read = permit('STAFF');
const operate = permit('STAFF');
const owner = permit('OWNER');
const CATEGORY_CODES = Object.freeze(['BOBTAIL', 'TRACTOR_TRAILER']);

function wholeNumber(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw apiError('VALIDATION_ERROR', `Choose a valid ${label}`);
  return number;
}

function cents(value, label, { minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > 100000000) {
    throw apiError('VALIDATION_ERROR', `${label} must be a valid amount in whole cents`);
  }
  return number;
}

function normalizedCategory(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!CATEGORY_CODES.includes(code)) throw apiError('VALIDATION_ERROR', 'Choose Bobtail or General Truck parking');
  return code;
}

async function audit(client, req, action, entityType, entityId, metadata = {}) {
  await client.query(`INSERT INTO parking_audit_events(admin_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,$2,$3,$4,$5)`, [req.admin.id, action, entityType, String(entityId), JSON.stringify(metadata)]);
}

function customerPayload(body) {
  const firstName = cleanText(body.firstName, 80, 'First name', true);
  const lastName = cleanText(body.lastName, 80, 'Last name', true);
  const mobilePhone = phone(body.mobilePhone);
  const customerEmail = email(body.email);
  const companyName = cleanText(String(body.companyName || '').replace(/\s+/g, ' '), 160, 'Company / Carrier');
  const usdotNumber = String(body.usdotNumber || '').replace(/\D/g, '');
  const mcNumber = String(body.mcNumber || '').replace(/\D/g, '');
  if (body.usdotNumber && !usdotNumber) throw apiError('VALIDATION_ERROR', 'Enter a valid USDOT number');
  if (body.mcNumber && !mcNumber) throw apiError('VALIDATION_ERROR', 'Enter a valid MC number');
  if (usdotNumber.length > 12) throw apiError('VALIDATION_ERROR', 'USDOT number is too long');
  if (mcNumber.length > 12) throw apiError('VALIDATION_ERROR', 'MC number is too long');
  return { firstName, lastName, mobilePhone, email: customerEmail, companyName,
    usdotNumber: usdotNumber || null, mcNumber: mcNumber || null };
}

function vehiclePayload(body, categoryCode) {
  return {
    unitNumber: cleanText(body.unitNumber, 80, 'Unit number', true),
    licensePlate: cleanText(body.licensePlate, 30, 'License plate', true).toUpperCase(),
    licensePlateState: cleanText(body.licensePlateState, 40, 'License plate state', true).toUpperCase(),
    trailerNumber: cleanText(body.trailerNumber, 80, 'Trailer number'),
    classification: categoryCode === 'BOBTAIL' ? 'BOBTAIL' : 'GENERAL'
  };
}

async function deskRequest(client, body) {
  const locationId = wholeNumber(body.locationId, 'parking location');
  const location = (await client.query('SELECT * FROM parking_locations WHERE id=$1 AND active', [locationId])).rows[0];
  if (!location) throw apiError('NOT_FOUND', 'The parking location is unavailable', 404);
  const requestedProduct = String(body.duration || '').trim().toUpperCase();
  const openEnded = requestedProduct === 'MONTHLY'
    || (requestedProduct === 'WEEKLY' && !body.departureLocal);
  const local = locationInterval(body.arrivalLocal, body.departureLocal, location.timezone, { allowOpenEnded: openEnded });
  const duration = validateBookingPolicy(local.start, local.end, location.timezone, body.duration);
  const categoryCode = normalizedCategory(body.categoryCode);
  // Monthly always takes a numbered space. Daily and Weekly take one when staff pick a space
  // (from the Live Lot or the Desk); otherwise they sell area capacity as before.
  const selectedSpotId = wholeNumber(body.selectedSpotId, 'parking space', { optional: true });
  if (selectedSpotId && openEnded && duration === 'WEEKLY') throw apiError('VALIDATION_ERROR', 'Enter a departure date to assign a numbered space to Weekly parking');
  const assignmentMode = duration === 'MONTHLY' || selectedSpotId ? 'CUSTOMER_SELECTED_SPOT' : 'ZONE_CAPACITY';
  return {
    locationId: Number(location.id), zoneId: wholeNumber(body.zoneId, 'parking area', { optional: true }),
    categoryCode, duration, arrival: local.start, departure: openEnded ? monthlyOccupancyEnd() : local.end,
    bookingDeparture: openEnded ? null : local.end, openEnded,
    arrivalLocal: local.arrivalLocal, departureLocal: local.departureLocal,
    customerAssignmentMode: assignmentMode, selectedSpotId: selectedSpotId || null, location
  };
}

async function positionsFor(client, request, slot) {
  const term = request.duration;
  const eligible = term === 'DAILY' ? 'element.daily_eligible' : term === 'WEEKLY' ? 'element.weekly_eligible' : 'element.monthly_eligible';
  const rateColumn = term === 'DAILY' ? 'plan.daily_rate_cents' : term === 'WEEKLY' ? 'plan.weekly_rate_cents' : 'plan.monthly_rate_cents';
  const protectedUntil = new Date(new Date(request.departure).getTime()
    + Number(slot.turnaround_buffer_minutes || 0) * 60000).toISOString();
  const result = await client.query(`SELECT spot.id,spot.public_label,element.rate_plan_id
    FROM parking_spots spot
    JOIN parking_lot_layouts layout ON layout.location_id=spot.location_id AND layout.status='PUBLISHED'
    JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.parking_spot_id=spot.id
      AND element.element_type='PARKING_SPOT' AND element.active AND element.public_visible
    JOIN parking_rate_rules plan ON plan.id=element.rate_plan_id AND plan.active
      AND plan.location_id=spot.location_id AND plan.category_id=$3
      AND (plan.zone_id IS NULL OR plan.zone_id=spot.zone_id)
      AND (plan.starts_at IS NULL OR plan.starts_at<=$4) AND (plan.ends_at IS NULL OR plan.ends_at>$4)
      AND ${rateColumn} IS NOT NULL
    WHERE spot.location_id=$1 AND element.inventory_id=$2 AND spot.active AND spot.public_bookable
      AND spot.classification_state='COMPLETE' AND element.parking_purpose='CUSTOMER'
      AND element.space_public_bookable AND ${eligible}
      AND NOT EXISTS (SELECT 1 FROM parking_spot_blocks block WHERE block.parking_spot_id=spot.id
        AND block.released_at IS NULL AND block.starts_at<$5
        AND COALESCE(block.ends_at,'infinity'::timestamptz)>$4)
      AND NOT EXISTS (SELECT 1 FROM reservation_spot_assignments assignment
        JOIN parking_bookings booking ON booking.id=assignment.booking_id
        WHERE assignment.parking_spot_id=spot.id AND assignment.released_at IS NULL
        AND booking.status IN ('CONFIRMED','CHECKED_IN') AND assignment.reserved_arrival_at<$5
        AND assignment.protected_until_at>$4)
    ORDER BY spot.display_order,spot.public_label,spot.id`, [request.locationId, slot.inventory_id,
    slot.category_id, request.arrival, protectedUntil]);
  const positions = [];
  for (const row of result.rows) {
    const quote = await priceQuote(client, request, slot, { rateRuleId: row.rate_plan_id });
    positions.push({ id: Number(row.id), label: row.public_label, standardPriceCents: Number(quote.totalCents) });
  }
  return positions;
}

async function availabilityView(client, request, { lock = false, excludeBookingId = null } = {}) {
  const slots = await availability(client, request, { lock, excludeBookingId });
  const values = [];
  for (const slot of slots) {
    const rate = await publicRateOfferForInventory(client, request, slot);
    const durationRate = rate.durations.find(item => item.code === request.duration);
    const positions = slot.available ? await positionsFor(client, request, slot) : [];
    const standard = slot.available && request.duration !== 'MONTHLY'
      ? await priceQuote(client, request, slot)
      : null;
    values.push({
      inventoryId: Number(slot.inventory_id), zoneId: Number(slot.zone_id), zone: slot.zone_name,
      categoryCode: slot.category_code,
      category: slot.category_code === 'BOBTAIL' ? 'Bobtail' : 'General Truck Parking',
      assignmentMode: slot.assignment_mode, available: Boolean(slot.available),
      remainingCapacity: slot.assignment_mode === 'ZONE_CAPACITY'
        ? Math.max(0, Number(slot.effective_capacity || 0) - Number(slot.used || 0))
        : Number(slot.available_spots || positions.length),
      startingPriceCents: durationRate ? Number(durationRate.unitRateCents) : null,
      standardPriceCents: standard ? Number(standard.totalCents) : null,
      positions
    });
  }
  return { slots, values };
}

async function resolveCustomer(client, submitted) {
  const data = customerPayload(submitted);
  const existingPublicId = cleanText(submitted.existingPublicId, 90, 'Existing customer');
  if (existingPublicId) {
    const customer = (await client.query(`SELECT * FROM parking_customers
      WHERE public_id=$1 AND status<>'SUSPENDED' FOR UPDATE`, [existingPublicId])).rows[0];
    if (!customer) throw apiError('CUSTOMER_NOT_FOUND', 'The selected customer is unavailable', 404);
    return { customer, data, created: false };
  }
  const resolved = await customerIdentity.resolveOrCreateCustomer(client, data);
  if (resolved.conflict) throw apiError('CUSTOMER_IDENTITY_CONFLICT',
    'The phone and email match different customer accounts. Select the correct customer; accounts were not merged.', 409);
  if (resolved.created) {
    await client.query(`UPDATE parking_customers SET display_name=$2,company_name=$3,usdot_number=$4,mc_number=$5,status='ACTIVE'
      WHERE id=$1`, [resolved.customer.id, `${data.firstName} ${data.lastName}`, data.companyName, data.usdotNumber, data.mcNumber]);
  }
  return { customer: resolved.customer, data, created: resolved.created };
}

async function resolveVehicle(client, submitted, customerId, categoryCode) {
  const data = vehiclePayload(submitted, categoryCode);
  const existingPublicId = cleanText(submitted.existingPublicId, 90, 'Existing vehicle');
  if (existingPublicId) {
    const vehicle = (await client.query(`SELECT * FROM parking_customer_vehicles
      WHERE public_id=$1 AND customer_id=$2 AND active FOR UPDATE`, [existingPublicId, customerId])).rows[0];
    if (!vehicle || !vehicle.unit_number || !vehicle.license_plate || !vehicle.license_plate_state) {
      throw apiError('VEHICLE_NOT_AVAILABLE', 'The selected vehicle does not contain the required booking details', 409);
    }
    await client.query('UPDATE parking_customer_vehicles SET last_used_at=now() WHERE id=$1', [vehicle.id]);
    return { vehicle, data: { ...data, unitNumber: vehicle.unit_number, licensePlate: vehicle.license_plate,
      licensePlateState: vehicle.license_plate_state }, created: false };
  }
  const vehicle = (await client.query(`INSERT INTO parking_customer_vehicles(
      public_id,customer_id,unit_number,license_plate,license_plate_state,vehicle_classification,last_used_at)
    VALUES($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (customer_id,upper(license_plate),upper(license_plate_state))
      WHERE license_plate IS NOT NULL AND license_plate_state IS NOT NULL
    DO UPDATE SET unit_number=EXCLUDED.unit_number,vehicle_classification=EXCLUDED.vehicle_classification,
      active=true,last_used_at=now()
    RETURNING *`, [`veh_${token(24)}`, customerId, data.unitNumber, data.licensePlate,
    data.licensePlateState, data.classification])).rows[0];
  return { vehicle, data, created: true };
}

async function bookingView(client, bookingId) {
  const booking = (await client.query(`SELECT booking.*,customer.public_id customer_public_id,
      creator.display_name created_by_name,creator.username created_by_username,
      location.name location_name,location.address,location.timezone,zone.name zone_name,
      category.code category_code,category.name category_name,price.snapshot,
      override_row.standard_price_cents,override_row.final_price_cents,
      override_row.reason override_reason,requested_spot.public_label requested_spot_label
    FROM parking_bookings booking
    JOIN parking_locations location ON location.id=booking.location_id
    JOIN parking_inventory inventory ON inventory.id=booking.inventory_id
    JOIN parking_zones zone ON zone.id=inventory.zone_id
    JOIN parking_categories category ON category.id=booking.category_id
    LEFT JOIN parking_customers customer ON customer.id=booking.customer_id
    LEFT JOIN parking_admin_users creator ON creator.id=booking.created_by_admin_user_id
    LEFT JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
    LEFT JOIN parking_spots requested_spot ON requested_spot.id=booking.requested_parking_spot_id
    LEFT JOIN LATERAL (SELECT * FROM parking_booking_price_overrides item
      WHERE item.booking_id=booking.id ORDER BY item.created_at DESC,item.id DESC LIMIT 1) override_row ON true
    WHERE booking.id=$1`, [bookingId])).rows[0];
  if (!booking) throw apiError('NOT_FOUND', 'Reservation not found', 404);
  // Keep these reads on the caller's transaction and sequence them. A pg Client
  // cannot safely execute concurrent queries on the same connection.
  const overrides = await client.query(`SELECT item.*,admin.display_name admin_name,admin.username admin_username
      FROM parking_booking_price_overrides item JOIN parking_admin_users admin ON admin.id=item.admin_user_id
      WHERE item.booking_id=$1 ORDER BY item.created_at DESC,item.id DESC`, [bookingId]);
  const documents = await client.query(`SELECT public_id,document_type,original_filename,upload_status,verification_status,
        revision,uploaded_at,created_at FROM parking_customer_documents
      WHERE booking_id=$1 AND superseded_at IS NULL ORDER BY created_at DESC`, [bookingId]);
  const billing = await client.query(`SELECT period_start,amount_due_cents,due_date FROM parking_customer_billing_periods
      WHERE booking_id=$1 ORDER BY period_start DESC LIMIT 1`, [bookingId]);
  const history = await client.query(`SELECT history.*,admin.display_name admin_name,admin.username admin_username
      FROM parking_booking_status_history history LEFT JOIN parking_admin_users admin ON admin.id=history.admin_user_id
      WHERE history.booking_id=$1 ORDER BY history.created_at DESC,history.id DESC`, [bookingId]);
  const events = await client.query(`SELECT event.action,event.metadata,event.created_at,admin.display_name admin_name,admin.username admin_username
      FROM parking_audit_events event LEFT JOIN parking_admin_users admin ON admin.id=event.admin_user_id
      WHERE event.entity_type='booking' AND event.entity_id=$1::text
      ORDER BY event.created_at DESC,event.id DESC LIMIT 100`, [bookingId]);
  const standardPriceCents = Number(booking.standard_price_cents ?? booking.snapshot?.totalCents ?? 0);
  const finalPriceCents = Number(booking.final_price_cents ?? standardPriceCents);
  const toLocalInput = value => value && DateTime.fromJSDate(new Date(value), { zone: 'utc' })
    .setZone(booking.timezone).toFormat("yyyy-LL-dd'T'HH:mm");
  return {
    reservation: {
      id: Number(booking.id), reservationNumber: booking.reservation_number, version: Number(booking.version),
      source: booking.booking_source, status: booking.status, paymentStatus: booking.payment_status,
      financiallyPaid: booking.payment_status === 'PAID' || Boolean(booking.payment_confirmed_at),
      demo: booking.payment_status === 'DEMO_BYPASSED',
      product: booking.parking_product, assignmentMode: booking.assignment_mode_snapshot,
      arrivalAt: booking.arrival_at, departureAt: booking.departure_at,
      arrivalLocal: toLocalInput(booking.arrival_at), departureLocal: toLocalInput(booking.departure_at),
      monthlyStatus: booking.parking_product === 'MONTHLY' ? (booking.departure_at ? 'ENDED' : 'ACTIVE') : null,
      weeklyStatus: isOpenEndedWeekly(booking)
        ? (booking.status === 'CONFIRMED' && new Date(booking.arrival_at) > new Date() ? 'Upcoming / Reserved' : 'Active') : null,
      nextBillingAt: ['WEEKLY', 'MONTHLY'].includes(booking.parking_product) && !booking.departure_at
        ? booking.snapshot?.nextBillingAt || null : null,
      currentBillingPeriod: billing.rows[0] || null,
      firstName: booking.first_name, lastName: booking.last_name, phone: booking.mobile_phone,
      email: booking.email, companyName: booking.company_name, usdotNumber: booking.usdot_number,
      unitNumber: booking.tractor_unit_number, licensePlate: booking.license_plate,
      licensePlateState: booking.license_plate_state, trailerNumber: booking.trailer_number,
      customerNotes: booking.customer_notes, internalNotes: booking.operational_notes,
      customerPublicId: booking.customer_public_id, location: booking.location_name, address: booking.address,
      timezone: booking.timezone, area: booking.zone_name,
      categoryCode: booking.category_code, category: booking.category_name,
      selectedPosition: booking.assigned_spot_label || booking.requested_spot_label || null,
      standardPriceCents, finalPriceCents, overrideDifferenceCents: finalPriceCents - standardPriceCents,
      overrideReason: booking.override_reason || null,
      createdBy: booking.created_by_name || booking.created_by_username || null,
      checkoutUrl: booking.payment_status === 'CHECKOUT_PENDING' ? booking.stripe_checkout_url : null,
      checkoutExpiresAt: booking.stripe_checkout_expires_at || null,
      pendingExpiresAt: booking.pending_expires_at || null
    },
    priceOverrides: overrides.rows,
    documents: documents.rows,
    statusHistory: history.rows,
    audit: events.rows
  };
}

router.get('/reservation-desk/bootstrap', read, async (req, res, next) => {
  try {
    const locations = await pool.query(`SELECT location.id,location.name,location.address,location.timezone,
        location.phone,location.active,
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object('code',category.code,
          'name',CASE WHEN category.code='BOBTAIL' THEN 'Bobtail' ELSE 'General Truck Parking' END))
          FILTER (WHERE category.code=ANY($1::text[])),'[]'::jsonb) categories
      FROM parking_locations location
      LEFT JOIN parking_zones zone ON zone.location_id=location.id AND zone.active
      LEFT JOIN parking_inventory inventory ON inventory.zone_id=zone.id AND inventory.active
      LEFT JOIN parking_categories category ON category.id=inventory.category_id AND category.active
      WHERE location.active GROUP BY location.id ORDER BY location.name`, [CATEGORY_CODES]);
    res.json({ locations: locations.rows, permissions: req.admin.permissions,
      payment: { mode: config.paymentMode, onlinePayment: !payOnSite(), stripeCheckoutConfigured: stripeGateway.checkoutConfigured(), currency: config.stripe.currency },
      demoPayment: { enabled: config.demoPaymentBypass.enabled },
      documents: { secureUploadConfigured: require('../services/privateDocumentStorage').configured() },
      notifications: { emailConfigured: customerNotifications.emailConfigured(), smsConfigured: customerNotifications.smsConfigured() } });
  } catch (error) { next(error); }
});

router.get('/reservation-desk/customers', read, async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json({ customers: [] });
    const rows = await pool.query(`SELECT customer.public_id,customer.first_name,customer.last_name,
        customer.display_name,customer.company_name,customer.display_phone,customer.display_email,
        customer.usdot_number,customer.mc_number,customer.status,customer.lifecycle_status,
        COALESCE(jsonb_agg(jsonb_build_object('publicId',vehicle.public_id,'unitNumber',vehicle.unit_number,
          'licensePlate',vehicle.license_plate,'licensePlateState',vehicle.license_plate_state,
          'classification',vehicle.vehicle_classification) ORDER BY vehicle.last_used_at DESC NULLS LAST,vehicle.id DESC)
          FILTER (WHERE vehicle.id IS NOT NULL AND vehicle.active),'[]'::jsonb) vehicles
      FROM parking_customers customer LEFT JOIN parking_customer_vehicles vehicle ON vehicle.customer_id=customer.id
      WHERE customer.status<>'SUSPENDED' AND (concat_ws(' ',customer.display_name,customer.first_name,
        customer.last_name,customer.company_name,customer.display_phone,customer.display_email,
        customer.usdot_number,customer.mc_number) ILIKE $1 OR EXISTS (
          SELECT 1 FROM parking_customer_vehicles matching_vehicle
          WHERE matching_vehicle.customer_id=customer.id AND matching_vehicle.active
            AND concat_ws(' ',matching_vehicle.license_plate,matching_vehicle.license_plate_state,
              matching_vehicle.unit_number) ILIKE $1))
      GROUP BY customer.id ORDER BY lower(COALESCE(customer.display_name,customer.company_name,
        concat_ws(' ',customer.first_name,customer.last_name))),customer.id LIMIT 12`, [`%${query}%`]);
    res.json({ customers: rows.rows.map(row => ({ publicId: row.public_id, firstName: row.first_name,
      lastName: row.last_name, displayName: row.display_name || [row.first_name, row.last_name].filter(Boolean).join(' ') || row.company_name,
      companyName: row.company_name, phone: row.display_phone, email: row.display_email,
      usdotNumber: row.usdot_number, mcNumber: row.mc_number, status: row.status,
      lifecycleStatus: row.lifecycle_status, vehicles: row.vehicles })) });
  } catch (error) { next(error); }
});

router.post('/reservation-desk/customers', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resolved = await resolveCustomer(client, req.body || {});
    const data = resolved.data;
    await audit(client, req, 'RESERVATION_DESK_CUSTOMER_SAVED', 'customer', resolved.customer.id, { created: resolved.created });
    await client.query('COMMIT');
    res.status(resolved.created ? 201 : 200).json({
      created: resolved.created,
      customer: {
        publicId: resolved.customer.public_id,
        firstName: data.firstName,
        lastName: data.lastName,
        displayName: `${data.firstName} ${data.lastName}`.trim(),
        companyName: data.companyName,
        phone: data.mobilePhone,
        email: data.email,
        usdotNumber: data.usdotNumber,
        mcNumber: data.mcNumber,
        vehicles: []
      }
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/reservation-desk/availability', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await expirePendingBookings(client); await expireQuoteHolds(client);
    const request = await deskRequest(client, req.body); const result = await availabilityView(client, request);
    await client.query('COMMIT');
    res.json({ request: { locationId: request.locationId, duration: request.duration, categoryCode: request.categoryCode,
      arrival: request.arrival, departure: request.departure, arrivalLocal: request.arrivalLocal,
      departureLocal: request.departureLocal, timezone: request.location.timezone }, options: result.values });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

router.post('/reservation-desk/reservations', csrf, operate, async (req, res, next) => {
  const idempotencyKey = String(req.get('idempotency-key') || '');
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) return next(apiError('IDEMPOTENCY_KEY_REQUIRED', 'Submit with a valid idempotency key'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); await expirePendingBookings(client); await expireQuoteHolds(client);
    const keyHash = digest(`admin-desk:${req.admin.id}:${idempotencyKey}`); const requestHash = digest(JSON.stringify(req.body));
    const duplicate = (await client.query('SELECT id,idempotency_request_hash FROM parking_bookings WHERE idempotency_hash=$1 FOR UPDATE', [keyHash])).rows[0];
    if (duplicate) {
      if (duplicate.idempotency_request_hash !== requestHash) throw apiError('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for different reservation details', 409);
      const result = await bookingView(client, duplicate.id); await client.query('COMMIT'); return res.json(result);
    }
    const request = await deskRequest(client, req.body.parking || {}); const { slots } = await availabilityView(client, request, { lock: true });
    const requestedInventoryId = wholeNumber(req.body.parking?.inventoryId, 'parking option');
    const slot = slots.find(item => Number(item.inventory_id) === requestedInventoryId && item.available);
    if (!slot) throw apiError('PARKING_NOT_AVAILABLE', 'This parking option is no longer available', 409);
    let selectedSpot = null;
    if (request.duration === 'MONTHLY' || request.selectedSpotId) selectedSpot = await selectExactSpot(client, { slot, arrival: request.arrival,
      departure: request.departure, preferredSpotId: request.duration === 'MONTHLY' ? wholeNumber(req.body.parking?.selectedSpotId, 'monthly parking position') : request.selectedSpotId });
    const standard = await priceQuote(client, request, slot, { rateRuleId: selectedSpot?.rate_plan_id || null });
    const standardPriceCents = cents(standard.totalCents, 'Standard price'); const overrideEnabled = req.body.price?.override === true;
    const finalPriceCents = overrideEnabled ? cents(req.body.price?.finalPriceCents, 'Final reservation price', { minimum: 50 }) : standardPriceCents;
    const overrideReason = overrideEnabled ? cleanText(req.body.price?.reason, 1000, 'Price override reason', true) : null;
    if (overrideEnabled && !req.admin.permissions.includes('reservation.price_override')) throw apiError('PERMISSION_DENIED', 'Your role cannot override reservation prices', 403);
    const resolvedCustomer = await resolveCustomer(client, req.body.customer || {});
    const resolvedVehicle = await resolveVehicle(client, req.body.vehicle || {}, resolvedCustomer.customer.id, request.categoryCode);
    const customerNotes = cleanText(req.body.customerNotes, 1000, 'Customer notes') || '';
    const internalNotes = cleanText(req.body.internalNotes, 4000, 'Internal notes') || '';
    const lookupCredential = token(24);
    const onSite = payOnSite();
    let booking = (await client.query(`INSERT INTO parking_bookings(
        reservation_number,public_token,lookup_credential_hash,idempotency_hash,idempotency_scope_hash,idempotency_request_hash,
        inventory_id,location_id,category_id,status,assignment_mode_snapshot,requested_parking_spot_id,pending_expires_at,arrival_at,departure_at,
        first_name,last_name,mobile_phone,email,company_name,usdot_number,tractor_unit_number,license_plate,
        license_plate_state,trailer_number,special_instructions,operational_notes,customer_notes,
        terms_accepted_at,cancellation_terms_accepted_at,parking_product,payment_status,customer_id,
        booking_source,created_by_admin_user_id,terms_acceptance_source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
        $24,$25,$26,$27,now(),now(),$28,$31,$29,'ADMIN_DESK',$30,'ADMIN_DESK') RETURNING *`, [
      reservationNumber(), token(), await bcrypt.hash(lookupCredential, 12), keyHash, digest(`admin-desk:${req.admin.id}`), requestHash,
      slot.inventory_id, request.locationId, slot.category_id, request.customerAssignmentMode, selectedSpot?.id || null, onSite ? null : pendingExpiryAt(), request.arrival,
      request.bookingDeparture, resolvedCustomer.data.firstName, resolvedCustomer.data.lastName, resolvedCustomer.data.mobilePhone,
      resolvedCustomer.data.email, resolvedCustomer.data.companyName, resolvedCustomer.data.usdotNumber,
      resolvedVehicle.data.unitNumber, resolvedVehicle.data.licensePlate, resolvedVehicle.data.licensePlateState,
      resolvedVehicle.data.trailerNumber, customerNotes || null, internalNotes, customerNotes,
      request.duration, resolvedCustomer.customer.id, req.admin.id, onSite ? 'NOT_REQUIRED' : 'DRAFT'])).rows[0];
    await client.query('INSERT INTO parking_booking_price_snapshots(booking_id,snapshot) VALUES($1,$2)',
      [booking.id, JSON.stringify({ ...standard, paymentMode: onSite ? 'PAY_ON_SITE' : 'STRIPE_CHECKOUT', standardTotalCents: standardPriceCents })]);
    await client.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,admin_user_id,reason,note,version)
      VALUES($1,'PENDING','ADMIN',$2,'Created in Reservation Desk',$3,1)`, [booking.id, req.admin.id, onSite ? 'Pay on site' : 'Awaiting secure payment']);
    if (overrideEnabled) {
      const override = (await client.query(`INSERT INTO parking_booking_price_overrides(
          booking_id,standard_price_cents,final_price_cents,difference_cents,reason,admin_user_id)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [booking.id, standardPriceCents, finalPriceCents,
        finalPriceCents - standardPriceCents, overrideReason, req.admin.id])).rows[0];
      await audit(client, req, 'RESERVATION_PRICE_OVERRIDE', 'booking', booking.id, { overrideId: Number(override.id),
        standardPriceCents, finalPriceCents, differenceCents: finalPriceCents - standardPriceCents,
        reason: overrideReason, previousOverrideId: null });
    }
    await audit(client, req, 'ADMIN_RESERVATION_CREATED', 'booking', booking.id, {
      customerId: Number(resolvedCustomer.customer.id), customerCreated: resolvedCustomer.created,
      vehicleId: Number(resolvedVehicle.vehicle.id), vehicleCreated: resolvedVehicle.created,
      product: request.duration, inventoryId: Number(slot.inventory_id), selectedSpotId: selectedSpot ? Number(selectedSpot.id) : null,
      standardPriceCents, finalPriceCents, paymentStatus: onSite ? 'NOT_REQUIRED' : 'DRAFT' });
    if (onSite) {
      booking = await confirmOnSiteBooking(client, { ...booking, category_code: request.categoryCode }, {
        actorType: 'ADMIN', adminUserId: req.admin.id, reason: 'Created in Reservation Desk; payment due on site'
      });
    }
    const result = await bookingView(client, booking.id); await client.query('COMMIT'); res.status(201).json(result);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (['40001', '23505', '23P01'].includes(error.code)) return next(apiError('PARKING_NOT_AVAILABLE', 'Availability changed while the reservation was being created. Review it and try again.', 409));
    next(error);
  } finally { client.release(); }
});

router.get('/reservation-desk/reservations/:id', read, async (req, res, next) => {
  try { res.json(await bookingView(pool, wholeNumber(req.params.id, 'reservation'))); } catch (error) { next(error); }
});

router.post('/reservation-desk/reservations/:id/demo-payment-authorization', csrf, owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const authorization = await demoPaymentBypass.issueAuthorization(client, {
      bookingId: wholeNumber(req.params.id, 'reservation'),
      adminUserId: req.admin.id,
      initiator: 'ADMIN'
    });
    await client.query('COMMIT');
    res.status(201).json({ demoAuthorization: authorization });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/reservation-desk/demo-payment-authorizations/revoke-unused', csrf, owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invalidated = await demoPaymentBypass.revokeUnused(client, { adminUserId: req.admin.id });
    await client.query('COMMIT');
    res.json({ invalidated });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/reservation-desk/reservations/:id/price-override', csrf, owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bookingId = wholeNumber(req.params.id, 'reservation'); const version = wholeNumber(req.body.version, 'current reservation version');
    const finalPriceCents = cents(req.body.finalPriceCents, 'Final reservation price', { minimum: 50 });
    const reason = cleanText(req.body.reason, 1000, 'Price override reason', true); await client.query('BEGIN');
    const booking = (await client.query(`SELECT booking.*,price.snapshot FROM parking_bookings booking
      JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id WHERE booking.id=$1 FOR UPDATE OF booking`, [bookingId])).rows[0];
    if (!booking) throw apiError('NOT_FOUND', 'Reservation not found', 404);
    if (booking.booking_source !== 'ADMIN_DESK') throw apiError('PRICE_OVERRIDE_NOT_ALLOWED', 'Reservation Desk overrides can only change employee-created reservations', 409);
    if (Number(booking.version) !== version) throw apiError('BOOKING_VERSION_CONFLICT', 'This reservation changed; refresh and try again', 409);
    const onSiteEditable = booking.payment_status === 'NOT_REQUIRED' && ['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(booking.status);
    if (!onSiteEditable && (booking.status !== 'PENDING' || booking.payment_status !== 'DRAFT')) throw apiError('PRICE_OVERRIDE_NOT_ALLOWED', 'Price can only be changed before secure checkout begins', 409);
    const standardPriceCents = cents(booking.snapshot?.standardTotalCents ?? booking.snapshot?.totalCents, 'Standard price');
    const previous = (await client.query('SELECT * FROM parking_booking_price_overrides WHERE booking_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [booking.id])).rows[0] || null;
    const override = (await client.query(`INSERT INTO parking_booking_price_overrides(
        booking_id,standard_price_cents,final_price_cents,difference_cents,reason,admin_user_id,previous_override_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [booking.id, standardPriceCents, finalPriceCents,
      finalPriceCents - standardPriceCents, reason, req.admin.id, previous?.id || null])).rows[0];
    await client.query('UPDATE parking_bookings SET version=version+1,updated_at=now() WHERE id=$1 AND version=$2', [booking.id, version]);
    await audit(client, req, 'RESERVATION_PRICE_OVERRIDE', 'booking', booking.id, { overrideId: Number(override.id),
      standardPriceCents, finalPriceCents, differenceCents: finalPriceCents - standardPriceCents, reason,
      previousOverrideId: previous ? Number(previous.id) : null,
      previousFinalPriceCents: previous ? Number(previous.final_price_cents) : standardPriceCents });
    await ensureOnSiteCharges(client, (await client.query('SELECT * FROM parking_bookings WHERE id=$1', [booking.id])).rows[0]);
    const result = await bookingView(client, booking.id); await client.query('COMMIT'); res.json(result);
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); } finally { client.release(); }
});

router.post('/reservation-desk/reservations/:id/end-monthly', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.body.confirmed !== true) throw apiError('CHANGE_CONFIRMATION_REQUIRED', 'Confirm the Monthly end date', 409);
    const bookingId = wholeNumber(req.params.id, 'reservation');
    await client.query('BEGIN');
    const booking = (await client.query(`SELECT booking.*,location.timezone FROM parking_bookings booking
      JOIN parking_locations location ON location.id=booking.location_id WHERE booking.id=$1 FOR UPDATE OF booking`, [bookingId])).rows[0];
    if (!booking) throw apiError('NOT_FOUND', 'Reservation not found', 404);
    if (booking.parking_product !== 'MONTHLY' || booking.departure_at) throw apiError('MONTHLY_END_NOT_ALLOWED', 'Only an active open-ended Monthly reservation can be ended', 409);
    const end = locationInterval(booking.arrival_at ? DateTime.fromJSDate(new Date(booking.arrival_at), { zone: 'utc' }).setZone(booking.timezone).toFormat("yyyy-LL-dd'T'HH:mm") : '', req.body.effectiveEndLocal, booking.timezone).end;
    if (new Date(end) <= new Date(booking.arrival_at)) throw apiError('INVALID_BOOKING_INTERVAL', 'Monthly end must be after the start', 422);
    await client.query(`UPDATE parking_bookings SET departure_at=$2,subscription_status='ENDED',version=version+1,updated_at=now() WHERE id=$1`, [booking.id, end]);
    await client.query(`UPDATE reservation_spot_assignments SET reserved_departure_at=$2,protected_until_at=$2
      WHERE booking_id=$1 AND released_at IS NULL`, [booking.id, end]);
    await audit(client, req, 'MONTHLY_PARKING_ENDED', 'booking', booking.id, { effectiveEndAt: end });
    const result = await bookingView(client, booking.id); await client.query('COMMIT'); res.json(result);
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); } finally { client.release(); }
});

router.patch('/reservation-desk/reservations/:id', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.body.confirmed !== true) throw apiError('CHANGE_CONFIRMATION_REQUIRED', 'Confirm the before and after changes', 409);
    const bookingId = wholeNumber(req.params.id, 'reservation'); const version = wholeNumber(req.body.version, 'current reservation version');
    const map = {
      firstName: ['first_name', value => cleanText(value, 80, 'First name', true)], lastName: ['last_name', value => cleanText(value, 80, 'Last name', true)],
      mobilePhone: ['mobile_phone', phone], email: ['email', email], companyName: ['company_name', value => cleanText(value, 120, 'Company / Carrier')],
      usdotNumber: ['usdot_number', value => { const digits = String(value || '').replace(/\D/g, ''); if (digits.length > 12) throw apiError('VALIDATION_ERROR', 'USDOT number is too long'); return digits || null; }],
      unitNumber: ['tractor_unit_number', value => cleanText(value, 80, 'Unit number', true)], licensePlate: ['license_plate', value => cleanText(value, 30, 'License plate', true).toUpperCase()],
      licensePlateState: ['license_plate_state', value => cleanText(value, 40, 'License plate state', true).toUpperCase()], trailerNumber: ['trailer_number', value => cleanText(value, 80, 'Trailer number')],
      customerNotes: ['customer_notes', value => cleanText(value, 1000, 'Customer notes') || ''], internalNotes: ['operational_notes', value => cleanText(value, 4000, 'Internal notes') || '']
    };
    const changes = Object.entries(map).filter(([key]) => req.body.changes?.[key] !== undefined);
    const dateChangeRequested = req.body.changes?.arrivalLocal !== undefined || req.body.changes?.departureLocal !== undefined;
    if (!changes.length && !dateChangeRequested) throw apiError('VALIDATION_ERROR', 'No permitted reservation changes were provided');
    await client.query('BEGIN');
    const booking = (await client.query(`SELECT booking.*,location.timezone,category.code category_code
      FROM parking_bookings booking
      JOIN parking_locations location ON location.id=booking.location_id
      JOIN parking_categories category ON category.id=booking.category_id
      WHERE booking.id=$1 FOR UPDATE OF booking`, [bookingId])).rows[0];
    if (!booking) throw apiError('NOT_FOUND', 'Reservation not found', 404);
    if (Number(booking.version) !== version) throw apiError('BOOKING_VERSION_CONFLICT', 'This reservation changed; refresh and try again', 409);
    if (['COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'].includes(booking.status)) throw apiError('BOOKING_CHANGE_NOT_ALLOWED', 'Closed reservations cannot be edited', 409);
    if (dateChangeRequested && booking.payment_status !== 'DRAFT'
        && !(booking.payment_status === 'NOT_REQUIRED' && ['PENDING', 'CONFIRMED'].includes(booking.status))) {
      throw apiError('BOOKING_CHANGE_NOT_ALLOWED', 'Arrival and departure can only change before secure checkout begins', 409);
    }
    const before = {}; const after = {}; const updates = []; const values = []; let repricedCents = null;
    for (const [key, [column, normalize]] of changes) {
      before[key] = booking[column]; after[key] = normalize(req.body.changes[key]);
      values.push(after[key]); updates.push(`${column}=$${values.length}`);
    }
    if (dateChangeRequested) {
      const localInput = value => value ? DateTime.fromJSDate(new Date(value), { zone: 'utc' })
        .setZone(booking.timezone).toFormat("yyyy-LL-dd'T'HH:mm") : null;
      const requested = await deskRequest(client, {
        locationId: booking.location_id, duration: booking.parking_product,
        categoryCode: booking.category_code,
        arrivalLocal: req.body.changes.arrivalLocal ?? localInput(booking.arrival_at),
        departureLocal: req.body.changes.departureLocal ?? localInput(booking.departure_at)
      });
      // Check the new dates the same way the booking was sold: its own space, or area capacity.
      const holdsSpace = booking.assignment_mode_snapshot === 'CUSTOMER_SELECTED_SPOT';
      requested.customerAssignmentMode = booking.assignment_mode_snapshot;
      const { slots } = await availabilityView(client, requested, { lock: true, excludeBookingId: booking.id });
      const slot = slots.find(item => Number(item.inventory_id) === Number(booking.inventory_id) && item.available);
      if (!slot) throw apiError('PARKING_NOT_AVAILABLE', 'The selected parking area has no capacity for the updated dates. No changes were saved.', 409);
      // Pay-on-site bookings are charged from their price, so new dates get a new price.
      if (booking.payment_status === 'NOT_REQUIRED') {
        let rateRuleId = null;
        if (holdsSpace) {
          const held = await currentAssignment(client, booking.id);
          const spotId = held?.parking_spot_id || booking.requested_parking_spot_id;
          if (spotId) rateRuleId = (await client.query(`SELECT element.rate_plan_id FROM parking_layout_elements element
            JOIN parking_lot_layouts layout ON layout.id=element.layout_id AND layout.status='PUBLISHED'
            WHERE element.parking_spot_id=$1 AND element.element_type='PARKING_SPOT' AND element.active LIMIT 1`, [spotId])).rows[0]?.rate_plan_id || null;
        }
        repricedCents = cents((await priceQuote(client, requested, slot, { rateRuleId })).totalCents, 'Updated price');
      }
      if (holdsSpace) {
        const assignment = await currentAssignment(client, booking.id, { lock: true });
        if (!assignment && booking.status === 'PENDING') {
          await selectExactSpot(client, { slot, arrival: requested.arrival, departure: requested.departure,
            preferredSpotId: wholeNumber(booking.requested_parking_spot_id, 'parking space') });
        } else {
        if (!assignment) throw apiError('MONTHLY_POSITION_UNAVAILABLE', 'This reservation no longer has a protected space', 409);
        const protectedUntil = new Date(new Date(requested.departure).getTime()
          + Number(slot.turnaround_buffer_minutes || 0) * 60000).toISOString();
        const conflict = (await client.query(`SELECT
          EXISTS (SELECT 1 FROM parking_spot_blocks block
            WHERE block.parking_spot_id=$1 AND block.released_at IS NULL
              AND block.starts_at<$4 AND COALESCE(block.ends_at,'infinity'::timestamptz)>$3)
          OR EXISTS (SELECT 1 FROM reservation_spot_assignments other
            JOIN parking_bookings other_booking ON other_booking.id=other.booking_id
            WHERE other.parking_spot_id=$1 AND other.released_at IS NULL AND other.booking_id<>$2
              AND other_booking.status IN ('CONFIRMED','CHECKED_IN')
              AND other.reserved_arrival_at<$4 AND other.protected_until_at>$3)
          blocked`,
        [assignment.parking_spot_id, booking.id, requested.arrival, protectedUntil])).rows[0];
        if (conflict.blocked) throw apiError('MONTHLY_POSITION_UNAVAILABLE',
          `Space ${assignment.public_label} is taken for the updated dates. No changes were saved.`, 409);
        await client.query(`UPDATE reservation_spot_assignments SET reserved_arrival_at=$2,
          reserved_departure_at=$3,protected_until_at=$4 WHERE id=$1`,
        [assignment.id, requested.arrival, requested.departure, protectedUntil]);
        }
      }
      before.arrivalLocal = localInput(booking.arrival_at); before.departureLocal = localInput(booking.departure_at);
      after.arrivalLocal = requested.arrivalLocal; after.departureLocal = requested.departureLocal;
      values.push(requested.arrival); updates.push(`arrival_at=$${values.length}`);
      values.push(requested.bookingDeparture); updates.push(`departure_at=$${values.length}`);
    }
    values.push(booking.id, version);
    await client.query(`UPDATE parking_bookings SET ${updates.join(',')},version=version+1,updated_at=now()
      WHERE id=$${values.length - 1} AND version=$${values.length}`, values);
    if (repricedCents != null) {
      const snapshot = (await client.query('SELECT snapshot FROM parking_booking_price_snapshots WHERE booking_id=$1', [booking.id])).rows[0]?.snapshot || {};
      const previous = (await client.query('SELECT * FROM parking_booking_price_overrides WHERE booking_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [booking.id])).rows[0] || null;
      const currentCents = previous ? Number(previous.final_price_cents) : Number(snapshot.totalCents);
      if (currentCents !== repricedCents) {
        const standardCents = cents(snapshot.standardTotalCents ?? snapshot.totalCents, 'Standard price');
        await client.query(`INSERT INTO parking_booking_price_overrides(
            booking_id,standard_price_cents,final_price_cents,difference_cents,reason,admin_user_id,previous_override_id)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [booking.id, standardCents, repricedCents, repricedCents - standardCents,
          'Re-priced for new dates', req.admin.id, previous?.id || null]);
        after.priceCents = repricedCents; before.priceCents = currentCents;
      }
    }
    await audit(client, req, 'ADMIN_RESERVATION_UPDATED', 'booking', booking.id, { before, after });
    await ensureOnSiteCharges(client, (await client.query('SELECT * FROM parking_bookings WHERE id=$1', [booking.id])).rows[0]);
    const result = await bookingView(client, booking.id); await client.query('COMMIT'); res.json(result);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23P01') return next(apiError('MONTHLY_POSITION_UNAVAILABLE', 'The reserved space became unavailable. No changes were saved.', 409));
    next(error);
  } finally { client.release(); }
});

router.post('/reservation-desk/reservations/:id/documents/insurance/upload', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bookingId = wholeNumber(req.params.id, 'reservation'); await client.query('BEGIN');
    const booking = (await client.query('SELECT parking_product FROM parking_bookings WHERE id=$1 FOR UPDATE', [bookingId])).rows[0];
    if (!booking) throw apiError('NOT_FOUND', 'Reservation not found', 404);
    if (booking.parking_product !== 'MONTHLY') throw apiError('DOCUMENT_NOT_REQUIRED', 'Insurance upload is available for Monthly parking', 409);
    const started = await customerDocuments.startUpload(client, { bookingId, documentType: 'INSURANCE', filename: req.body.filename,
      mimeType: req.body.mimeType, sizeBytes: req.body.sizeBytes });
    await audit(client, req, 'ADMIN_DOCUMENT_UPLOAD_STARTED', 'booking', bookingId, { documentId: started.document.public_id, documentType: 'INSURANCE' });
    await client.query('COMMIT'); res.status(201).json({ document: { id: started.document.public_id, type: 'INSURANCE', status: started.document.upload_status },
      uploadToken: started.uploadToken, upload: { ...started.signed, expiresAt: started.uploadExpiresAt } });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); } finally { client.release(); }
});

router.post('/reservation-desk/reservations/:id/documents/complete', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bookingId = wholeNumber(req.params.id, 'reservation'); await client.query('BEGIN');
    const completed = await customerDocuments.completeUpload(client, { bookingId, uploadToken: req.body.uploadToken, documentPublicId: req.body.documentId });
    await audit(client, req, 'ADMIN_DOCUMENT_UPLOAD_COMPLETED', 'booking', bookingId, { documentId: completed.document.public_id,
      documentType: 'INSURANCE', alreadyCompleted: completed.alreadyCompleted });
    await client.query('COMMIT'); res.json({ document: { id: completed.document.public_id, type: 'INSURANCE', status: completed.document.verification_status, receivedAt: completed.document.uploaded_at } });
  } catch (error) { if (error.documentRejectionPersisted) await client.query('COMMIT').catch(() => {}); else await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

router.post('/reservation-desk/reservations/:id/payment-link', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    stripeGateway.assertCheckoutConfigured(); const bookingId = wholeNumber(req.params.id, 'reservation'); await client.query('BEGIN');
    const booking = (await client.query(`SELECT booking.*,customer.stripe_customer_id customer_stripe_id,
        price.snapshot,override_row.final_price_cents FROM parking_bookings booking
      LEFT JOIN parking_customers customer ON customer.id=booking.customer_id
      JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
      LEFT JOIN LATERAL (SELECT final_price_cents FROM parking_booking_price_overrides item WHERE item.booking_id=booking.id ORDER BY item.created_at DESC,item.id DESC LIMIT 1) override_row ON true
      WHERE booking.id=$1 FOR UPDATE OF booking`, [bookingId])).rows[0];
    if (!booking) throw apiError('NOT_FOUND', 'Reservation not found', 404);
    if (booking.payment_status === 'CHECKOUT_PENDING' && booking.stripe_checkout_url) { await client.query('COMMIT'); return res.json({ checkout: { url: booking.stripe_checkout_url,
      expiresAt: booking.stripe_checkout_expires_at, mode: booking.parking_product === 'MONTHLY' || isOpenEndedWeekly(booking) ? 'subscription' : 'payment' } }); }
    if (booking.status !== 'PENDING' || booking.payment_status !== 'DRAFT') throw apiError('CHECKOUT_NOT_ALLOWED', 'This reservation cannot start secure checkout', 409);
    if (booking.parking_product === 'MONTHLY') {
      const slot = { location_id: booking.location_id, inventory_id: booking.inventory_id,
        turnaround_buffer_minutes: (await client.query('SELECT turnaround_buffer_minutes FROM parking_locations WHERE id=$1', [booking.location_id])).rows[0].turnaround_buffer_minutes,
        requested_duration: 'MONTHLY', timezone: 'UTC' };
      await selectExactSpot(client, { slot, arrival: booking.arrival_at, departure: booking.departure_at || monthlyOccupancyEnd(),
        preferredSpotId: wholeNumber(booking.requested_parking_spot_id, 'monthly parking position') });
    }
    const amount = cents(booking.final_price_cents ?? booking.snapshot?.totalCents, 'Final reservation price', { minimum: 50 });
    const monthly = booking.parking_product === 'MONTHLY'; const weekly = isOpenEndedWeekly(booking); const recurring = monthly || weekly;
    const metadata = { parking_booking_id: String(booking.id), parking_product: booking.parking_product, booking_source: 'ADMIN_DESK' };
    const recurringAmount = recurring ? cents(booking.snapshot?.recurringUnitRateCents, `Recurring ${monthly ? 'Monthly' : 'Weekly'} price`, { minimum: 50 }) : null;
    const requestedExpiry = Math.floor(Date.now() / 1000) + config.stripe.checkoutTtlSeconds;
    // Monthly lets Stripe create its one prorated invoice. Weekly uses a trial
    // until start + 7 days and one first-period item, so only $100 is due now.
    const weeklyPlan = weekly ? weeklyCheckoutPlan({ currency: config.stripe.currency, initialAmountCents: amount,
      recurringAmountCents: recurringAmount, metadata, arrival: booking.arrival_at }) : null;
    const lineItems = monthly
      ? [{ quantity: 1, price_data: { currency: config.stripe.currency, unit_amount: recurringAmount,
        product_data: { name: 'Monthly Parking', metadata }, recurring: { interval: 'month' } } }]
      : weekly ? weeklyPlan.lineItems
      : [{ quantity: 1, price_data: { currency: config.stripe.currency, unit_amount: amount,
        product_data: { name: `${booking.parking_product === 'WEEKLY' ? 'Weekly' : 'Daily'} Parking`, metadata } } }];
    const billingCycleAnchor = monthly ? Math.floor(Date.parse(booking.snapshot?.nextBillingAt) / 1000) : null;
    if (monthly && (!Number.isSafeInteger(billingCycleAnchor) || billingCycleAnchor <= Math.floor(Date.now() / 1000))) {
      throw apiError('PAYMENT_QUOTE_INVALID', 'The server-generated next billing date is invalid', 409);
    }
    const session = await stripeGateway.createCheckoutSession({ mode: recurring ? 'subscription' : 'payment', payment_method_types: ['card'], client_reference_id: String(booking.id),
      ...(booking.customer_stripe_id ? { customer: booking.customer_stripe_id } : { customer_email: booking.email, ...(recurring ? {} : { customer_creation: 'always' }) }),
      line_items: lineItems,
      metadata, ...(monthly ? { subscription_data: { metadata, billing_cycle_anchor: billingCycleAnchor } }
        : weekly ? { subscription_data: weeklyPlan.subscriptionData } : { payment_intent_data: { metadata } }), expires_at: requestedExpiry,
      success_url: `${config.customerAppUrl}/#my-parking`, cancel_url: `${config.customerAppUrl}/#my-parking`
    }, `parkingops-admin-checkout:${booking.id}:${booking.version}`);
    if (!session?.id || !session?.url) throw apiError('STRIPE_CHECKOUT_FAILED', 'Stripe did not return a usable Checkout Session', 502);
    const expiresAt = new Date(Number(session.expires_at || requestedExpiry) * 1000).toISOString();
    const holdExpiresAt = new Date(new Date(expiresAt).getTime() + config.stripe.webhookGraceSeconds * 1000).toISOString();
    await client.query(`UPDATE parking_bookings SET payment_status='CHECKOUT_PENDING',stripe_checkout_session_id=$2,
      stripe_checkout_url=$3,stripe_checkout_expires_at=$4,pending_expires_at=$5,checkout_created_at=now(),version=version+1,updated_at=now() WHERE id=$1`,
    [booking.id, session.id, session.url, expiresAt, holdExpiresAt]);
    await audit(client, req, 'ADMIN_PAYMENT_LINK_CREATED', 'booking', booking.id, { checkoutSessionId: session.id, amountCents: amount, expiresAt, mode: recurring ? 'subscription' : 'payment' });
    await client.query('COMMIT'); res.status(201).json({ checkout: { url: session.url, expiresAt, mode: recurring ? 'subscription' : 'payment' } });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); } finally { client.release(); }
});

router.post('/reservation-desk/reservations/:id/notification', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bookingId = wholeNumber(req.params.id, 'reservation');
    const kind = String(req.body.kind || '').trim().toUpperCase();
    if (!['CONFIRMATION', 'PAYMENT_LINK'].includes(kind)) throw apiError('VALIDATION_ERROR', 'Choose a reservation confirmation or payment-link notice');
    await client.query('BEGIN');
    const booking = (await client.query('SELECT * FROM parking_bookings WHERE id=$1 FOR UPDATE', [bookingId])).rows[0];
    if (!booking) throw apiError('NOT_FOUND', 'Reservation not found', 404);
    if (booking.booking_source !== 'ADMIN_DESK') throw apiError('NOTIFICATION_NOT_ALLOWED', 'Reservation Desk notices apply only to employee-created reservations', 409);
    if (kind === 'PAYMENT_LINK' && (booking.payment_status !== 'CHECKOUT_PENDING' || !booking.stripe_checkout_url)) {
      throw apiError('PAYMENT_LINK_REQUIRED', 'Create a current secure payment link before sending it', 409);
    }
    const channel = booking.email && customerNotifications.emailConfigured() ? 'EMAIL'
      : booking.mobile_phone && customerNotifications.smsConfigured() ? 'SMS' : null;
    const destination = channel === 'EMAIL' ? booking.email : channel === 'SMS' ? booking.mobile_phone : null;
    if (!channel) throw apiError('NOTIFICATION_DELIVERY_NOT_CONFIGURED', 'No configured notification channel is available for this customer', 503);
    const eventType = kind === 'PAYMENT_LINK' ? 'ADMIN_PAYMENT_LINK_CREATED' : 'ADMIN_RESERVATION_CREATED';
    const payload = { reservationNumber: booking.reservation_number,
      ...(kind === 'PAYMENT_LINK' ? { checkoutUrl: booking.stripe_checkout_url, expiresAt: booking.stripe_checkout_expires_at } : {}) };
    const outboxId = await customerNotifications.enqueue(client, { customerId: booking.customer_id,
      bookingId: booking.id, eventType, channel, destination, payload });
    await audit(client, req, 'ADMIN_RESERVATION_NOTIFICATION_QUEUED', 'booking', booking.id,
      { outboxId, kind, channel, paymentStatus: booking.payment_status });
    await client.query('COMMIT'); res.status(202).json({ queued: true, kind, channel });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); } finally { client.release(); }
});

module.exports = router;
