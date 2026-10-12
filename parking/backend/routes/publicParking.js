const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const pool = require('../db');
const config = require('../config');
const { availability, priceQuote, rateOffer, publicRateOfferForInventory, durationFor } = require('../services/parkingService');
const { assertTransition, pendingExpiryAt, expirePendingBookings } = require('../services/bookingWorkflow');
const { assignSelectedExactSpot, selectExactSpot, currentAssignment, expireQuoteHolds, releaseCurrentAssignment, recordAssignmentArrival, recordAssignmentDeparture } = require('../services/exactSpaceService');
const { apiError, token, digest, reservationNumber, cleanText, email, phone, locationInterval } = require('../utils');
const { CANONICAL_LAYOUT_PREFIX, resolveCanonicalLot, canonicalPublicCategories } = require('../services/canonicalLot');
const { requestedDuration, validateBookingPolicy, monthlyOccupancyEnd } = require('../services/bookingPolicy');
const { SUPPORTED_PUBLIC_DURATIONS, filterSupportedPublicDurations, isSupportedPublicDuration } = require('../services/publicParkingProducts');
const { catalogCategoryOffers } = require('../services/publicProductDiscovery');
const { SUPPORTED_PUBLIC_CATEGORY_CODES, assertPublicCategory, publicCategoryName, publicTerms, bookingActions } = require('../services/publicBookingContract');
const stripeGateway = require('../services/stripeGateway');
const privateDocumentStorage = require('../services/privateDocumentStorage');
const { authorizedBooking } = require('../services/customerBookingAccess');
const { resolveOrCreateCustomer } = require('../services/customerIdentity');
const customerNotifications = require('../services/customerNotifications');
const demoPaymentBypass = require('../services/demoPaymentBypass');
const { payOnSite, paymentInstructions, ensureOnSiteCharges } = require('../services/onSiteBooking');
const { activateCustomerFromBooking } = require('../services/customerIdentity');
const canonicalLotLayout = require('../data/trucker-heaven-real-lot-layout.v1.json');

const router = express.Router();
const publicLimit = limit => rateLimit({
  windowMs: 60 * 60 * 1000,
  limit,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => next(apiError('PUBLIC_RATE_LIMITED', 'Too many requests. Please try again later.', 429))
});
const bookingLimit = publicLimit(config.rateLimits.booking);
const lookupLimit = publicLimit(config.rateLimits.lookup);

function canonicalSpaceGeometry(number) {
  const row = canonicalLotLayout.rows.find(item => number >= item.range[0] && number <= item.range[1]);
  if (!row) return null;
  const direction = row.numberDirection === 'DESCENDING' ? -1 : 1;
  const first = direction === -1 ? row.range[1] : row.range[0];
  const index = (number - first) * direction;
  const columns = Number(row.columns || 1);
  const gap = Number(row.gap || 0);
  return {
    x: Number(row.x) + (index % columns) * (Number(row.width) + gap),
    y: Number(row.y) + Math.floor(index / columns) * Number(row.step || (Number(row.height) + gap)),
    width: Number(row.width), height: Number(row.height), rotation: Number(row.rotation || 0)
  };
}

function canonicalCustomerDecorations() {
  return canonicalLotLayout.elements.map((element, index) => ({
    elementKey: element.key || `customer-canonical-${index}`,
    elementType: element.type,
    label: element.label || '',
    x: Number(element.x), y: Number(element.y), width: Number(element.width), height: Number(element.height),
    rotation: Number(element.rotation || 0), layerOrder: Number(element.layer || 1)
  }));
}

async function bookingInput(client, body) {
  const requestedAssignmentModes = [body.assignmentMode, body.assignment_mode]
    .map(value => String(value || '').trim().toUpperCase()).filter(Boolean);
  const publicAreaId = String(body.parkingAreaId || '').trim();
  const publicLocationId = String(body.locationId || '').trim();
  const categoryCode = String(body.categoryCode || '').trim().toUpperCase();
  assertPublicCategory(categoryCode);
  const select = `SELECT z.id zone_id,z.public_id zone_public_id,z.name zone_name,
      l.id, l.public_id, l.name, l.address, l.timezone, l.phone, l.booking_approval_mode,
      payment_instructions, cancellation_cutoff_hours,assignment_mode,exact_mode_active,self_service_enabled,
      road_directions_url,arrival_instructions,exit_instructions,check_in_early_minutes,check_in_late_minutes,
      turnaround_buffer_minutes,
      EXISTS(SELECT 1 FROM parking_lot_layouts canonical
        WHERE canonical.location_id=l.id AND canonical.status='PUBLISHED' AND canonical.name LIKE $1) canonical_customer_lot
      FROM parking_zones z JOIN parking_locations l ON l.id=z.location_id`;
  let area;
  let legacyLocationRequest = false;
  let canonicalLotRequest = false;
  if (publicAreaId) {
    if (!/^pa_[a-f0-9]{32}$/.test(publicAreaId)) throw apiError('VALIDATION_ERROR', 'Choose a parking area');
    area = await client.query(`${select}
      WHERE z.public_id=$2 AND z.active AND z.public_visible AND l.active`, [`${CANONICAL_LAYOUT_PREFIX}%`, publicAreaId]);
    if (!area.rowCount) throw apiError('PARKING_AREA_NOT_FOUND', 'The selected parking area is unavailable', 404);
  } else if (publicLocationId) {
    // Temporary deployment compatibility for the already-deployed customer app.
    // New parkingAreaId requests always remain strictly zone-scoped.
    if (!/^pl_[a-f0-9]{32}$/.test(publicLocationId)) throw apiError('VALIDATION_ERROR', 'Choose a parking area');
    area = await client.query(`${select}
      WHERE l.public_id=$2 AND l.active
      ORDER BY z.display_order,z.id LIMIT 1`, [`${CANONICAL_LAYOUT_PREFIX}%`, publicLocationId]);
    if (!area.rowCount) throw apiError('LOCATION_NOT_FOUND', 'The selected parking location is unavailable', 404);
    legacyLocationRequest = true;
  } else {
    // The active customer application deliberately sends no location or zone.
    // Resolve the one audited physical lot server-side, while retaining legacy
    // IDs as compatibility-only persistence details for older clients.
    const canonical = await resolveCanonicalLot(client);
    area = { rows: [{ ...canonical, zone_id: null, zone_public_id: null, zone_name: 'Trucker Heaven Parking' }], rowCount: 1 };
    canonicalLotRequest = true;
  }
  const canonicalAreaOnly = canonicalLotRequest || Boolean(area.rows[0].canonical_customer_lot);
  const requestedProduct = String(body.duration || '').trim().toUpperCase();
  const businessInterval = locationInterval(body.arrivalLocal, body.departureLocal, area.rows[0].timezone, { allowOpenEnded: requestedProduct === 'MONTHLY' });
  const duration = requestedDuration(body.duration, businessInterval.start, businessInterval.end, area.rows[0].timezone);
  validateBookingPolicy(businessInterval.start, businessInterval.end, area.rows[0].timezone, duration);
  // Monthly drivers pick their numbered space. Daily and Weekly book the area: the map shows
  // where they can park, and the office places them on a space when they arrive.
  const customerAssignmentMode = duration === 'MONTHLY' ? 'CUSTOMER_SELECTED_SPOT' : 'ZONE_CAPACITY';
  if (requestedAssignmentModes.some(mode => mode !== customerAssignmentMode)) {
    throw apiError('ASSIGNMENT_BEHAVIOR_MISMATCH', 'The selected parking term determines how parking is assigned.', 409);
  }
  return {
    locationId: area.rows[0].id,
    zoneId: legacyLocationRequest ? null : area.rows[0].zone_id,
    parkingAreaId: legacyLocationRequest ? null : area.rows[0].zone_public_id,
    legacyLocationRequest,
    canonicalLotRequest,
    canonicalAreaOnly,
    categoryCode,
    duration,
    customerAssignmentMode,
    arrival: businessInterval.start,
    departure: duration === 'MONTHLY' ? monthlyOccupancyEnd() : businessInterval.end,
    bookingDeparture: duration === 'MONTHLY' ? null : businessInterval.end,
    arrivalLocal: businessInterval.arrivalLocal,
    departureLocal: businessInterval.departureLocal,
    location: area.rows[0]
  };
}

function localDisplay(instant, timezone) {
  if (!instant) return null;
  const { DateTime } = require('luxon');
  const value = instant instanceof Date ? DateTime.fromJSDate(instant) : DateTime.fromISO(String(instant), { zone: 'utc' });
  return value.isValid ? value.setZone(timezone || 'UTC').toFormat("ccc, LLL d, yyyy h:mm a ZZZZ") : null;
}

function publicRatePlanName(value) {
  const name = String(value || '').trim();
  return name && !/weekly/i.test(name) ? name : 'Parking rate';
}

function spotAssignmentMode(value) {
  const mode = String(value || '').toUpperCase();
  return mode === 'CUSTOMER_SELECTED_SPOT' || mode === 'EXACT_SPOT';
}

function customerParkingInstructions(assignmentMode, areaInstructions = '') {
  return assignmentMode === 'CUSTOMER_SELECTED_SPOT'
    ? 'Park only in the space you picked during the reservation period.'
    : areaInstructions || 'Park in any open space inside the highlighted area. The office can direct you to one.';
}

function publicQuote(quote) {
  const { rateRuleId: _rateRuleId, rateRuleVersion: _rateRuleVersion, ...safeQuote } = quote || {};
  const supported = isSupportedPublicDuration(safeQuote.duration);
  safeQuote.ratePlanName = publicRatePlanName(safeQuote.ratePlanName);
  if (safeQuote.duration === 'MONTHLY' && safeQuote.openEnded) safeQuote.departure = null;
  if (!supported) {
    safeQuote.duration = null;
    delete safeQuote.units;
    delete safeQuote.unitRateCents;
    delete safeQuote.baseParkingCents;
  }
  const stableQuote = Object.fromEntries(Object.keys(safeQuote).sort().map(key => [key, safeQuote[key]]));
  return { ...safeQuote, quoteId: digest(JSON.stringify(stableQuote)).slice(0, 20) };
}

function canonicalCustomerGroups() {
  return canonicalLotLayout.rows.filter(row => SUPPORTED_PUBLIC_CATEGORY_CODES.includes(row.category) && row.publicBookable !== false).map(row => {
    const low = Number(row.range[0]); const high = Number(row.range[1]);
    const first = row.numberDirection === 'DESCENDING' ? high : low;
    const last = row.numberDirection === 'DESCENDING' ? low : high;
    const spots = Array.from({ length: high - low + 1 }, (_, index) => canonicalSpaceGeometry(low + index)).filter(Boolean);
    const x = Math.min(...spots.map(spot => spot.x)); const y = Math.min(...spots.map(spot => spot.y));
    const right = Math.max(...spots.map(spot => spot.x + spot.width));
    return { key: row.key, label: `${first}–${last}${row.category === 'BOBTAIL' ? ' · Bobtail' : ''}`, x, y: Math.max(0, y - 1.6), width: right - x, height: 1.3 };
  });
}

function normalizedCustomer(body, { monthly = false } = {}) {
  const companyName = String(body.companyName || '').replace(/\s+/g, ' ');
  const usdotNumber = String(body.usdotNumber || '').replace(/\D/g, '');
  if (body.usdotNumber && !usdotNumber) throw apiError('VALIDATION_ERROR', 'Enter a valid USDOT number');
  return {
    firstName: cleanText(body.firstName, 80, 'First name', true),
    lastName: cleanText(body.lastName, 80, 'Last name', true),
    mobilePhone: phone(body.mobilePhone),
    email: email(body.email),
    companyName: cleanText(companyName, 120, 'Company / Carrier name', monthly),
    usdotNumber: cleanText(usdotNumber, 12, 'USDOT number'),
    tractorUnitNumber: cleanText(body.tractorUnitNumber, 80, 'Truck or tractor unit number', true),
    licensePlate: cleanText(body.licensePlate, 30, 'License plate', true).toUpperCase(),
    licensePlateState: cleanText(body.licensePlateState, 40, 'License plate state', true).toUpperCase(),
    trailerNumber: cleanText(body.trailerNumber, 80, 'Trailer number'),
    specialInstructions: cleanText(body.specialInstructions, 1000, 'Special instructions')
  };
}

function selectedSpotId(value, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw apiError('MONTHLY_POSITION_REQUIRED', 'Choose an open parking space on the map.');
    return null;
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw apiError('VALIDATION_ERROR', 'Choose a valid parking space.');
  return id;
}

function quoteRequestHash(request, inventoryId, assignmentMode, parkingSpotId = null) {
  return digest(JSON.stringify({
    locationId: String(request.locationId), inventoryId: String(inventoryId),
    categoryCode: request.categoryCode, duration: request.duration, arrival: request.arrival, departure: request.departure,
    assignmentMode, parkingSpotId: parkingSpotId == null ? null : String(parkingSpotId)
  }));
}

function idempotencyRequestHash(request, customer, body) {
  return digest(JSON.stringify({
    locationId: String(request.locationId), zoneId: request.zoneId == null ? null : String(request.zoneId),
    categoryCode: request.categoryCode, duration: request.duration, arrival: request.arrival, departure: request.departure,
    selectedSpotId: body.selectedSpotId == null ? null : String(body.selectedSpotId),
    customer, termsAccepted: body.termsAccepted === true,
    cancellationTermsAccepted: body.cancellationTermsAccepted === true,
    termsVersion: body.termsVersion == null ? null : String(body.termsVersion),
    quoteTokenHash: body.quoteToken ? digest(String(body.quoteToken)) : null
  }));
}

async function rateBasisHash(client, rateRuleId, { parkingSpotId = null, inventoryId = null, assignmentMode = null, duration = null } = {}) {
  const result = await client.query(`SELECT id,location_id,zone_id,category_id,plan_name,
      CASE $2 WHEN 'DAILY' THEN daily_rate_cents WHEN 'WEEKLY' THEN weekly_rate_cents WHEN 'MONTHLY' THEN monthly_rate_cents ELSE NULL END unit_rate_cents,
      fee_cents,tax_basis_points,starts_at,ends_at,priority,active
    FROM parking_rate_rules WHERE id=$1`, [rateRuleId, duration]);
  if (!result.rowCount) return null;
  let spaceBasis = null;
  if (parkingSpotId !== null) {
    const space = await client.query(`SELECT e.inventory_id,e.rate_plan_id,e.active,e.public_visible,
        e.parking_purpose,e.space_public_bookable,
        CASE $2 WHEN 'DAILY' THEN e.daily_eligible WHEN 'WEEKLY' THEN e.weekly_eligible WHEN 'MONTHLY' THEN e.monthly_eligible ELSE false END product_eligible,
        s.active spot_active,s.classification_state,s.public_bookable
      FROM parking_spots s
      LEFT JOIN parking_lot_layouts layout ON layout.location_id=s.location_id AND layout.status='PUBLISHED'
      LEFT JOIN parking_layout_elements e ON e.layout_id=layout.id AND e.parking_spot_id=s.id
      WHERE s.id=$1`, [parkingSpotId, duration]);
    spaceBasis = space.rows[0] || null;
  }
  let areaBasis = null;
  if (inventoryId !== null) {
    const area = await client.query(`SELECT inventory.id,inventory.version,inventory.active,
        zone.id zone_id,zone.version zone_version,zone.active zone_active,zone.public_visible,
        location.assignment_mode,location.exact_mode_active,location.version location_version,
        layout.id layout_id,layout.version layout_version,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'element',element.element_key,'active',element.active,'public',element.public_visible,
          'purpose',element.parking_purpose,'bookable',element.space_public_bookable,
          'daily',element.daily_eligible,'weekly',element.weekly_eligible,'monthly',element.monthly_eligible,'ratePlan',element.rate_plan_id,
          'spotActive',spot.active,'spotPublic',spot.public_bookable,'classification',spot.classification_state,
          'spotVersion',spot.version) ORDER BY element.element_key)
          FROM parking_layout_elements element JOIN parking_spots spot ON spot.id=element.parking_spot_id
          WHERE element.layout_id=layout.id AND element.inventory_id=inventory.id),'[]'::jsonb) physical_basis
      FROM parking_inventory inventory JOIN parking_zones zone ON zone.id=inventory.zone_id
      JOIN parking_locations location ON location.id=zone.location_id
      LEFT JOIN parking_lot_layouts layout ON layout.location_id=location.id AND layout.status='PUBLISHED'
      WHERE inventory.id=$1`, [inventoryId]);
    areaBasis = area.rows[0] || null;
  }
  return digest(JSON.stringify({ rate: result.rows[0], assignmentMode, area: areaBasis, space: spaceBasis }));
}

function publicRateOffer(offer, selectedDuration = null) {
  const durations = filterSupportedPublicDurations(offer?.durations).map(item => ({
    code: item.code,
    unitRateCents: Number(item.unitRateCents)
  }));
  const selected = selectedDuration ? durations.find(item => item.code === selectedDuration) : null;
  return {
    ratePlan: durations.length ? publicRatePlanName(offer?.planName) : null,
    offeredDurations: durations,
    startingRateCents: durations.length ? Math.min(...durations.map(item => item.unitRateCents)) : null,
    pricingAvailable: selectedDuration ? Boolean(selected) : durations.length > 0
  };
}

function aggregateRateOffers(values, selectedDuration = null) {
  const choices = new Map();
  let selectedPlan = null;
  for (const value of values) {
    const offer = publicRateOffer(value.rateOffer, selectedDuration);
    for (const duration of offer.offeredDurations) {
      const current = choices.get(duration.code);
      if (!current || duration.unitRateCents < current.unitRateCents) choices.set(duration.code, { ...duration, ratePlan: offer.ratePlan });
    }
    if (!selectedPlan && offer.pricingAvailable) selectedPlan = offer.ratePlan;
  }
  const offeredDurations = [...choices.values()].sort((a, b) => SUPPORTED_PUBLIC_DURATIONS.indexOf(a.code) - SUPPORTED_PUBLIC_DURATIONS.indexOf(b.code));
  const selected = selectedDuration ? choices.get(selectedDuration) : null;
  return {
    ratePlan: selected?.ratePlan || selectedPlan || null,
    offeredDurations: offeredDurations.map(({ code, unitRateCents }) => ({ code, unitRateCents })),
    startingRateCents: offeredDurations.length ? Math.min(...offeredDurations.map(item => item.unitRateCents)) : null,
    pricingAvailable: selectedDuration ? Boolean(selected) : offeredDurations.length > 0
  };
}

function publicAvailabilityResults(values, request) {
  const selectedDuration = request.duration;
  const present = value => ({
    parkingAreaId: request.canonicalLotRequest ? null : value.zone_public_id,
    parkingArea: {
      id: value.zone_public_id || null,
      name: publicCategoryName(value.category_code, value.category_name),
      instructions: customerParkingInstructions(value.assignment_mode, value.arrival_directions || request.location.arrival_instructions)
    },
    categoryCode: value.category_code,
    category: value.category_name,
    zone: request.canonicalLotRequest ? 'Trucker Heaven Parking' : (value.public_visible ? value.zone_name : 'Parking area'),
    available: value.available,
    arrival: value.start,
    departure: value.end,
    arrivalLocal: request.arrivalLocal,
    departureLocal: request.departureLocal,
    timezone: value.timezone,
    restrictions: value.restrictions,
    assignmentMode: value.assignment_mode,
    numberedSpacesAvailable: spotAssignmentMode(value.assignment_mode) ? value.available_spots : null,
    remainingCapacity: !spotAssignmentMode(value.assignment_mode) && value.public_remaining_capacity ? (value.closed ? 0 : Math.max(0, value.effective_capacity - value.used)) : null,
    ...publicRateOffer(value.rateOffer, selectedDuration)
  });
  if (!request.canonicalLotRequest) return values.map(present);
  const categories = new Map();
  for (const value of values) {
    const current = categories.get(value.category_code);
    if (!current) { categories.set(value.category_code, { ...present(value), _sourceValues: [value] }); continue; }
    current.available ||= value.available;
    if (current.numberedSpacesAvailable !== null) current.numberedSpacesAvailable += Number(value.available_spots || 0);
    if (current.remainingCapacity !== null) current.remainingCapacity += value.public_remaining_capacity ? (value.closed ? 0 : Math.max(0, value.effective_capacity - value.used)) : 0;
    current._sourceValues.push(value);
  }
  return [...categories.values()].map(({ _sourceValues, ...category }) => ({ ...category, ...aggregateRateOffers(_sourceValues, selectedDuration) }));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  try { return value ? JSON.parse(value) : []; } catch (_) { return []; }
}

async function availabilityMapStates(client, request, values) {
  const duration = request.duration;
  // Area bookings count remaining capacity; numbered-space bookings count open spaces.
  const remainingFor = value => value.available_spots != null ? Number(value.available_spots)
    : (value.closed ? 0 : Math.max(0, Number(value.effective_capacity || 0) - Number(value.used || 0)));
  const remainingByInventory = new Map(values.map(value => [String(value.inventory_id), remainingFor(value)]));
  // Every space of the requested type and term is returned: free ones are marked available
  // (while capacity lasts), taken ones are marked eligible-but-unavailable so the map can show
  // them as taken. Spaces of another type or term are not marked at all.
  const candidates = await client.query(`SELECT e.element_key,e.inventory_id,
      (NOT EXISTS (SELECT 1 FROM parking_spot_blocks block
        WHERE block.parking_spot_id=s.id AND block.released_at IS NULL
          AND block.starts_at<($4::timestamptz + make_interval(mins=>l.turnaround_buffer_minutes))
          AND COALESCE(block.ends_at,'infinity'::timestamptz)>$3)
      AND NOT EXISTS (SELECT 1 FROM reservation_spot_assignments assignment
        WHERE assignment.parking_spot_id=s.id AND assignment.released_at IS NULL
          AND assignment.reserved_arrival_at<($4::timestamptz + make_interval(mins=>l.turnaround_buffer_minutes))
          AND assignment.protected_until_at>$3)
      AND NOT EXISTS (SELECT 1 FROM parking_closures closure
        WHERE closure.active AND closure.closure_type='FULL_CLOSURE' AND closure.starts_at<$4 AND closure.ends_at>$3
          AND (closure.location_id=s.location_id OR closure.zone_id=s.zone_id OR closure.inventory_id=e.inventory_id OR closure.category_id=i.category_id))) free
    FROM parking_lot_layouts layout
    JOIN parking_layout_elements e ON e.layout_id=layout.id
    JOIN parking_spots s ON s.id=e.parking_spot_id
    JOIN parking_zones z ON z.id=s.zone_id
    JOIN parking_inventory i ON i.id=e.inventory_id
    JOIN parking_categories c ON c.id=i.category_id
    JOIN parking_locations l ON l.id=s.location_id
    WHERE layout.location_id=$1 AND layout.status='PUBLISHED' AND e.active AND e.public_visible
      AND e.element_type='PARKING_SPOT' AND s.active AND z.active AND z.public_visible AND i.active AND c.active
      AND c.code=$2 AND s.classification_state='COMPLETE'
      AND e.space_public_bookable AND e.parking_purpose='CUSTOMER'
      AND (($5='DAILY' AND e.daily_eligible) OR ($5='WEEKLY' AND e.weekly_eligible)
        OR ($5='MONTHLY' AND e.monthly_eligible))
    ORDER BY e.inventory_id,e.layer_order,e.id`, [request.locationId, request.categoryCode, request.arrival, request.departure, duration]);
  const states = new Map();
  for (const candidate of candidates.rows) {
    const key = String(candidate.inventory_id);
    const remaining = remainingByInventory.get(key) || 0;
    const available = Boolean(candidate.free) && remaining > 0;
    states.set(candidate.element_key, { eligible: true, available });
    if (available) remainingByInventory.set(key, remaining - 1);
  }
  return { categoryCode: request.categoryCode, states };
}

// Every space on the published lot with its state for the requested term and dates.
// Open spaces carry a number and id so the driver can pick one on the map. Spaces another
// driver is holding right now show as taken; the asking driver's own hold (ownQuoteToken) stays open.
async function selectableSpaceStates(client, request, ownQuoteToken = null) {
  const rows = await client.query(`SELECT element.element_key,element.parking_spot_id,element.inventory_id,
      CASE $4 WHEN 'DAILY' THEN element.daily_eligible WHEN 'WEEKLY' THEN element.weekly_eligible
        ELSE element.monthly_eligible END term_eligible,
      element.space_public_bookable,element.parking_purpose,element.rate_plan_id,
      spot.public_label,spot.active spot_active,spot.classification_state,category.code category_code,
      CASE $4 WHEN 'DAILY' THEN plan.daily_rate_cents WHEN 'WEEKLY' THEN plan.weekly_rate_cents
        ELSE plan.monthly_rate_cents END term_rate_cents,
      block.id block_id,assignment.id assignment_id,assignment.booking_status,
      closure.id closure_id,hold.id hold_id
    FROM parking_lot_layouts layout
    JOIN parking_layout_elements element ON element.layout_id=layout.id
    JOIN parking_spots spot ON spot.id=element.parking_spot_id
    JOIN parking_inventory inventory ON inventory.id=element.inventory_id
    JOIN parking_categories category ON category.id=inventory.category_id
    JOIN parking_locations location ON location.id=spot.location_id
    LEFT JOIN parking_rate_rules plan ON plan.id=element.rate_plan_id
      AND plan.active AND plan.location_id=spot.location_id AND plan.category_id=inventory.category_id
      AND (plan.zone_id IS NULL OR plan.zone_id=spot.zone_id)
      AND (plan.starts_at IS NULL OR plan.starts_at<=$2)
      AND (plan.ends_at IS NULL OR plan.ends_at>$2)
    LEFT JOIN LATERAL (
      SELECT item.id FROM parking_spot_blocks item
      WHERE item.parking_spot_id=spot.id AND item.released_at IS NULL
        AND item.starts_at<($3::timestamptz + make_interval(mins=>location.turnaround_buffer_minutes))
        AND COALESCE(item.ends_at,'infinity'::timestamptz)>$2
      ORDER BY item.starts_at DESC LIMIT 1
    ) block ON true
    LEFT JOIN LATERAL (
      SELECT item.id,item.booking_id,current_booking.status booking_status
      FROM reservation_spot_assignments item
      JOIN parking_bookings current_booking ON current_booking.id=item.booking_id
        AND current_booking.status IN ('CONFIRMED','CHECKED_IN')
      WHERE item.parking_spot_id=spot.id AND item.released_at IS NULL
        AND item.reserved_arrival_at<($3::timestamptz + make_interval(mins=>location.turnaround_buffer_minutes))
        AND item.protected_until_at>$2
      ORDER BY item.assigned_at DESC LIMIT 1
    ) assignment ON true
    LEFT JOIN LATERAL (
      SELECT item.id FROM parking_closures item
      WHERE item.active AND item.closure_type='FULL_CLOSURE'
        AND item.starts_at<$3 AND item.ends_at>$2
        AND (item.location_id=spot.location_id OR item.zone_id=spot.zone_id
          OR item.inventory_id=element.inventory_id OR item.category_id=inventory.category_id)
      LIMIT 1
    ) closure ON true
    LEFT JOIN LATERAL (
      SELECT item.id FROM parking_public_quotes item
      WHERE item.parking_spot_id=spot.id AND item.assignment_mode='CUSTOMER_SELECTED_SPOT'
        AND item.consumed_booking_id IS NULL AND item.hold_released_at IS NULL AND item.hold_status='ACTIVE'
        AND COALESCE(item.checkout_hold_expires_at,item.expires_at)>now()
        AND item.arrival_at<($3::timestamptz + make_interval(mins=>location.turnaround_buffer_minutes))
        AND item.protected_until_at>$2
        AND ($5::text IS NULL OR item.token_hash<>$5)
      LIMIT 1
    ) hold ON true
    WHERE layout.location_id=$1 AND layout.status='PUBLISHED'
      AND element.element_type='PARKING_SPOT' AND element.active
    ORDER BY element.layer_order,element.id`, [request.locationId, request.arrival, request.departure, request.duration,
    ownQuoteToken ? digest(String(ownQuoteToken)) : null]);
  const states = new Map();
  const positions = [];
  for (const row of rows.rows) {
    const categoryMatches = row.category_code === request.categoryCode;
    const customerConfigured = row.spot_active && row.classification_state === 'COMPLETE'
      && row.parking_purpose === 'CUSTOMER' && row.space_public_bookable;
    const eligible = categoryMatches && customerConfigured && row.term_eligible
      && row.rate_plan_id && row.term_rate_cents != null;
    let state = 'NOT_ELIGIBLE';
    if (!customerConfigured) state = 'INTERNAL_SHOP_COMPANY';
    else if (eligible && (row.block_id || row.closure_id)) state = 'BLOCKED';
    else if (eligible && row.assignment_id) state = row.booking_status === 'CHECKED_IN' ? 'OCCUPIED' : 'RESERVED';
    else if (eligible && row.hold_id) state = 'HELD';
    else if (eligible) state = 'AVAILABLE';
    const item = {
      available: state === 'AVAILABLE',
      state,
      parkingSpotId: Number(row.parking_spot_id),
      number: eligible ? String(row.public_label) : null,
      eligible
    };
    states.set(row.element_key, item);
    if (eligible) positions.push(item);
  }
  return { categoryCode: request.categoryCode, assignmentMode: 'CUSTOMER_SELECTED_SPOT', states, positions };
}

function expose(row, credential) {
  const assignmentMode = row.assignment_mode_snapshot || (row.assignment_mode === 'EXACT_SPOT' && row.exact_mode_active ? 'EXACT_SPOT' : 'ZONE_CAPACITY');
  const assignedLabel = row.assignment_public_label || row.assigned_spot_label || null;
  const areaName = publicCategoryName(row.category_code, row.category_name) || 'Parking Area';
  const areaInstructions = customerParkingInstructions(assignmentMode, row.area_arrival_directions || row.arrival_instructions);
  return {
    reservationNumber: row.reservation_number,
    publicToken: row.public_token,
    status: row.status,
    parkingProduct: row.parking_product || (['DAILY', 'WEEKLY', 'MONTHLY'].includes(row.snapshot?.duration) ? row.snapshot.duration : 'DAILY'),
    paymentStatus: row.payment_status || 'NOT_REQUIRED',
    financiallyPaid: row.payment_status === 'PAID' || Boolean(row.payment_confirmed_at),
    demo: row.payment_status === 'DEMO_BYPASSED',
    billingStatus: row.subscription_status || null,
    paidThrough: row.billing_period_end_at || null,
    paymentGraceEndsAt: row.payment_grace_ends_at || null,
    manageBillingAvailable: row.parking_product === 'MONTHLY' && Boolean(row.stripe_customer_id),
    arrival: row.arrival_at,
    departure: row.departure_at,
    arrivalLocal: localDisplay(row.arrival_at, row.timezone),
    departureLocal: localDisplay(row.departure_at, row.timezone),
    timezone: row.timezone,
    location: 'Trucker Heaven Parking',
    category: row.category_name,
    firstName: row.first_name,
    lastName: row.last_name,
    companyName: row.company_name,
    usdotNumber: row.usdot_number,
    tractorUnitNumber: row.tractor_unit_number,
    licensePlate: row.license_plate,
    licensePlateState: row.license_plate_state,
    trailerNumber: row.trailer_number,
    // Internal zone/inventory names remain private. The public parking area is
    // the stable zone identity plus the customer-facing vehicle-area label.
    zone: areaName,
    assignmentMode,
    parkingTerm: row.snapshot?.duration || null,
    parkingArea: { id: row.zone_public_id || null, name: areaName, instructions: areaInstructions },
    assignedSpace: assignedLabel ? { label: assignedLabel } : null,
    assignedSpotLabel: assignedLabel,
    selectedMonthlyPosition: assignmentMode === 'CUSTOMER_SELECTED_SPOT' && assignedLabel ? { label: assignedLabel } : null,
    address: row.address,
    supportPhone: row.phone,
    roadDirectionsUrl: row.road_directions_url,
    instructions: row.area_arrival_directions || row.arrival_instructions,
    arrivalDirections: row.area_arrival_directions || row.arrival_instructions,
    exitDirections: row.area_exit_directions || row.exit_instructions,
    paymentInstructions: paymentInstructions(row),
    cancellationCutoffHours: row.cancellation_cutoff_hours,
    selfServiceEnabled: Boolean(row.self_service_enabled),
    actualArrival: row.actual_arrival_at,
    actualDeparture: row.actual_departure_at,
    price: publicQuote(row.snapshot),
    authoritative: true,
    customerNotes: asArray(row.customer_notes),
    actions: bookingActions(row),
    ...(row.public_map ? { map: row.public_map } : {}),
    ...(credential ? { lookupCredential: credential } : {})
  };
}

async function bookingRecord(client, where, ...values) {
  const result = await client.query(`SELECT b.*, l.name location_name,l.address,l.phone,l.timezone,l.arrival_instructions,
      l.exit_instructions,l.road_directions_url,l.payment_instructions,l.cancellation_cutoff_hours,
      l.assignment_mode current_assignment_mode,l.exact_mode_active,l.self_service_enabled,l.check_in_early_minutes,l.check_in_late_minutes,
      z.public_id zone_public_id,z.name zone_name,c.code category_code,c.name category_name,p.snapshot,a.parking_spot_id,s.public_label assignment_public_label,
      z.arrival_directions area_arrival_directions,z.exit_directions area_exit_directions,
      COALESCE((SELECT json_agg(json_build_object('note', n.note, 'createdAt', n.created_at) ORDER BY n.created_at)
        FROM parking_booking_notes n WHERE n.booking_id=b.id AND n.visibility='CUSTOMER'), '[]'::json) customer_notes
    FROM parking_bookings b
    JOIN parking_locations l ON l.id=b.location_id
    JOIN parking_inventory i ON i.id=b.inventory_id
    JOIN parking_zones z ON z.id=i.zone_id
    JOIN parking_categories c ON c.id=b.category_id
    JOIN parking_booking_price_snapshots p ON p.booking_id=b.id
    LEFT JOIN reservation_spot_assignments a ON a.booking_id=b.id AND a.released_at IS NULL
    LEFT JOIN parking_spots s ON s.id=a.parking_spot_id
    WHERE ${where}`, values);
  return result.rows[0];
}

function bookingAssignmentMode(row) {
  return row?.assignment_mode_snapshot || (row?.current_assignment_mode === 'EXACT_SPOT' && row?.exact_mode_active ? 'EXACT_SPOT' : 'ZONE_CAPACITY');
}

async function attachPublicMap(client, row) {
  if (!row) return row;
  row.public_map = spotAssignmentMode(bookingAssignmentMode(row))
    ? (row.parking_spot_id ? await publishedLayout(client, row.location_id, row.parking_spot_id) : null)
    : await publishedLayout(client, row.location_id, null, null, {
      inventoryId: row.inventory_id,
      name: publicCategoryName(row.category_code, row.category_name) || 'Parking Area',
      instructions: customerParkingInstructions(bookingAssignmentMode(row), row.area_arrival_directions || row.arrival_instructions),
      arrival: row.arrival_at,
      departure: row.departure_at
    });
  return row;
}

async function publishedLayout(client, locationId, assignedSpotId = null, availabilitySelection = null, parkingAreaSelection = null) {
  const layout = await client.query(`SELECT id,name,version,published_at FROM parking_lot_layouts
    WHERE location_id=$1 AND status='PUBLISHED'`, [locationId]);
  if (!layout.rowCount) return null;
  const canonicalLayout = String(layout.rows[0].name || '').startsWith('Trucker Heaven physical lot ·');
  const elements = await client.query(`SELECT e.element_type,e.element_key,e.label,e.x,e.y,e.width,e.height,e.rotation,e.layer_order,
      e.inventory_id,e.parking_spot_id,e.parking_purpose,e.daily_eligible,e.weekly_eligible,e.monthly_eligible,e.space_public_bookable,
      s.id spot_id,s.public_label spot_label,s.physical_section,s.parking_use,s.public_bookable,s.classification_state,
      z.name zone_name,c.code category_code,c.name category_name
    FROM parking_layout_elements e
    LEFT JOIN parking_spots s ON s.id=e.parking_spot_id
    LEFT JOIN parking_zones z ON z.id=COALESCE(e.zone_id,s.zone_id)
    LEFT JOIN parking_inventory i ON i.id=e.inventory_id
    LEFT JOIN parking_categories c ON c.id=i.category_id
    WHERE e.layout_id=$1 AND e.active
      AND (
        (e.parking_spot_id IS NULL
          AND e.public_visible
          AND (e.zone_id IS NULL OR (z.active AND z.public_visible))
          AND (e.inventory_id IS NULL OR (i.active AND z.active AND z.public_visible AND c.active AND c.code=ANY($2::text[]))))
        OR
        (e.parking_spot_id IS NOT NULL AND s.active AND i.active AND c.active
          AND ($3::boolean OR (
            e.public_visible AND z.active AND z.public_visible AND c.code=ANY($2::text[])
            AND s.classification_state='COMPLETE' AND e.parking_purpose='CUSTOMER' AND e.space_public_bookable
          )))
      )
    ORDER BY e.layer_order,e.id`, [layout.rows[0].id, SUPPORTED_PUBLIC_CATEGORY_CODES, canonicalLayout]);
  let route = null;
  let blockedAreaSpotIds = new Set();
  if (assignedSpotId !== null) {
    const directions = await client.query(`SELECT d.entrance_element_key,d.exit_element_key,
        d.arrival_route_element_keys,d.exit_route_element_keys,z.name area_name,z.arrival_directions
      FROM parking_spots s JOIN parking_zones z ON z.id=s.zone_id
      LEFT JOIN parking_area_directions d ON d.zone_id=s.zone_id
      WHERE s.id=$1 AND s.location_id=$2`, [assignedSpotId, locationId]);
    if (directions.rowCount) route = {
      entranceElementKey: directions.rows[0].entrance_element_key,
      exitElementKey: directions.rows[0].exit_element_key,
      arrivalRouteElementKeys: asArray(directions.rows[0].arrival_route_element_keys),
      exitRouteElementKeys: asArray(directions.rows[0].exit_route_element_keys),
      area: directions.rows[0].area_name,
      directions: directions.rows[0].arrival_directions ? [String(directions.rows[0].arrival_directions)] : []
    };
  } else if (parkingAreaSelection?.inventoryId) {
    if (parkingAreaSelection.arrival && parkingAreaSelection.departure) {
      const blocks = await client.query(`SELECT DISTINCT block.parking_spot_id FROM parking_spot_blocks block
        JOIN parking_spots spot ON spot.id=block.parking_spot_id
        WHERE spot.inventory_id=$1 AND block.released_at IS NULL
          AND block.starts_at<$3 AND COALESCE(block.ends_at,'infinity'::timestamptz)>$2`,
      [parkingAreaSelection.inventoryId, parkingAreaSelection.arrival, parkingAreaSelection.departure]);
      blockedAreaSpotIds = new Set(blocks.rows.map(row => String(row.parking_spot_id)));
    }
    const directions = await client.query(`SELECT d.entrance_element_key,d.exit_element_key,
        d.arrival_route_element_keys,d.exit_route_element_keys,z.name area_name,z.arrival_directions
      FROM parking_inventory inventory JOIN parking_zones z ON z.id=inventory.zone_id
      LEFT JOIN parking_area_directions d ON d.zone_id=z.id
      WHERE inventory.id=$1 AND z.location_id=$2`, [parkingAreaSelection.inventoryId, locationId]);
    if (directions.rowCount) route = {
      entranceElementKey: directions.rows[0].entrance_element_key,
      exitElementKey: directions.rows[0].exit_element_key,
      arrivalRouteElementKeys: asArray(directions.rows[0].arrival_route_element_keys),
      exitRouteElementKeys: asArray(directions.rows[0].exit_route_element_keys),
      area: parkingAreaSelection.name || directions.rows[0].area_name,
      directions: directions.rows[0].arrival_directions ? [String(directions.rows[0].arrival_directions)] : []
    };
  }
  const storedDecorations = elements.rows.filter(element => !element.parking_spot_id).map(element => ({
    elementKey: element.element_key, elementType: element.element_type, label: element.label || '',
    x: Number(element.x), y: Number(element.y), width: Number(element.width), height: Number(element.height),
    rotation: Number(element.rotation || 0), layerOrder: Number(element.layer_order || 0),
    ...(element.zone_name ? { zone: { name: element.zone_name } } : {}),
    ...(element.category_code ? { inventory: { categoryCode: element.category_code, category: publicCategoryName(element.category_code, element.category_name) } } : {})
  }));
  const storedDecorationTypes = new Set(storedDecorations.map(element => element.elementType));
  const fallbackDecorations = canonicalLayout
    ? canonicalCustomerDecorations().filter(element => !storedDecorationTypes.has(element.elementType))
    : [];
  const publicElements = [...storedDecorations, ...fallbackDecorations, ...elements.rows.filter(element => element.parking_spot_id).map(element => {
    const number = Number(String(element.spot_label || '').trim());
    const geometry = canonicalLayout ? canonicalSpaceGeometry(number) : null;
    const selection = availabilitySelection?.states.get(element.element_key);
    const matchesSelection = Boolean(availabilitySelection && element.parking_spot_id && element.category_code === availabilitySelection.categoryCode);
    const permitted = Boolean(parkingAreaSelection
      && String(element.inventory_id) === String(parkingAreaSelection.inventoryId)
      && !blockedAreaSpotIds.has(String(element.parking_spot_id)));
    return {
      elementKey: element.element_key, elementType: element.element_type, label: element.spot_label || element.label,
      x: geometry?.x ?? Number(element.x), y: geometry?.y ?? Number(element.y), width: geometry?.width ?? Number(element.width), height: geometry?.height ?? Number(element.height),
      rotation: geometry?.rotation ?? Number(element.rotation), layerOrder: Number(element.layer_order),
      assigned: assignedSpotId !== null && String(element.parking_spot_id) === String(assignedSpotId),
      ...(parkingAreaSelection ? { permitted } : {}),
      space: {
        id: Number(element.spot_id),
        number: selection?.number || element.spot_label,
        dailyEligible: Boolean(element.daily_eligible),
        monthlyEligible: Boolean(element.monthly_eligible),
        ...(selection ? { eligible: Boolean(selection.eligible) } : {}),
        publicBookable: Boolean(element.parking_purpose === null ? element.public_bookable : element.space_public_bookable),
        parkingPurpose: element.parking_purpose || null,
        ...(availabilitySelection ? {
          matchesSelection,
          available: Boolean(selection?.available),
          selectable: Boolean(selection?.available),
          selectionState: selection?.state || (matchesSelection ? (selection?.available ? 'AVAILABLE' : 'UNAVAILABLE') : 'NOT_ELIGIBLE')
        } : {})
      },
      ...(element.zone_name ? { zone: { name: element.zone_name } } : {}),
      ...(element.category_code ? { inventory: { categoryCode: element.category_code, category: publicCategoryName(element.category_code, element.category_name) } } : {})
    };
  })];
  if (route) {
    const keys = [route.entranceElementKey, ...(route.arrivalRouteElementKeys || [])].filter(Boolean);
    const routeElements = keys.map(key => publicElements.find(element => element.elementKey === key));
    const assigned = publicElements.find(element => element.assigned);
    const permitted = publicElements.filter(element => element.permitted);
    const destination = assigned || (permitted.length ? {
      x: permitted.reduce((sum, element) => sum + Number(element.x) + Number(element.width) / 2, 0) / permitted.length,
      y: permitted.reduce((sum, element) => sum + Number(element.y) + Number(element.height) / 2, 0) / permitted.length,
      width: 0, height: 0
    } : null);
    route.validated = Boolean(destination && keys.length && routeElements.every(Boolean));
    if (route.validated) route.points = [...routeElements, destination].map(element => ({ x: Number(element.x) + Number(element.width) / 2, y: Number(element.y) + Number(element.height) / 2 }));
  }
  return {
    name: layout.rows[0].name,
    version: Number(layout.rows[0].version),
    publishedAt: layout.rows[0].published_at,
    viewBox: canonicalLotLayout.viewBox || { x: 0, y: 0, width: 100, height: 100 },
    groups: canonicalLayout ? canonicalCustomerGroups() : [],
    elements: publicElements,
    ...(parkingAreaSelection ? { parkingArea: { name: parkingAreaSelection.name, instructions: parkingAreaSelection.instructions }, assignmentMode: 'ZONE_CAPACITY' } : {}),
    ...(availabilitySelection?.assignmentMode ? { assignmentMode: availabilitySelection.assignmentMode } : {}),
    ...(route ? { route } : {})
  };
}

async function withPendingExpiry(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expirePendingBookings(client);
    await expireQuoteHolds(client);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

router.get('/locations/:publicLocationId/layout', async (req, res, next) => {
  try {
    const publicLocationId = String(req.params.publicLocationId || '').trim();
    if (!/^pl_[a-f0-9]{32}$/.test(publicLocationId)) throw apiError('VALIDATION_ERROR', 'Choose a location');
    const location = await pool.query('SELECT id FROM parking_locations WHERE public_id=$1 AND active', [publicLocationId]);
    if (!location.rowCount) throw apiError('LOCATION_NOT_FOUND', 'The selected parking location is unavailable', 404);
    res.json({ layout: await publishedLayout(pool, location.rows[0].id) });
  } catch (error) { next(error); }
});

router.get('/parking-areas/:publicAreaId/layout', async (req, res, next) => {
  try {
    const publicAreaId = String(req.params.publicAreaId || '').trim();
    if (!/^pa_[a-f0-9]{32}$/.test(publicAreaId)) throw apiError('VALIDATION_ERROR', 'Choose a parking area');
    const area = await pool.query(`SELECT z.location_id FROM parking_zones z
      JOIN parking_locations l ON l.id=z.location_id
      WHERE z.public_id=$1 AND z.active AND z.public_visible AND l.active`, [publicAreaId]);
    if (!area.rowCount) throw apiError('PARKING_AREA_NOT_FOUND', 'The selected parking area is unavailable', 404);
    res.json({ layout: await publishedLayout(pool, area.rows[0].location_id) });
  } catch (error) { next(error); }
});

router.get('/canonical-lot', async (_req, res, next) => {
  try {
    const lot = await resolveCanonicalLot(pool);
    const categories = await canonicalPublicCategories(pool, lot.id);
    res.json({ lot: {
      name: 'Trucker Heaven Parking', timezone: lot.timezone, phone: lot.phone, address: lot.address,
      arrivalInstructions: lot.arrival_instructions, exitInstructions: lot.exit_instructions,
      roadDirectionsUrl: lot.road_directions_url, paymentInstructions: paymentInstructions(lot),
      cancellationCutoffHours: lot.cancellation_cutoff_hours,
      bookingPolicy: { minimumWeeklyDays: config.bookingPolicy.minimumWeeklyDays, minimumMonthlyDays: config.bookingPolicy.minimumMonthlyDays },
      assignmentMode: 'TERM_BASED',
      assignmentBehavior: { daily: 'AREA_CAPACITY', weekly: 'AREA_CAPACITY', monthly: 'CUSTOMER_SELECTED_POSITION' },
      selfServiceEnabled: Boolean(lot.self_service_enabled), terms: publicTerms(lot), categories: await catalogCategoryOffers(pool, lot.id, categories)
    }, layout: await publishedLayout(pool, lot.id) });
  } catch (error) { next(error); }
});

router.get('/locations', async (_req, res, next) => {
  try {
    const locations = await pool.query(`SELECT l.public_id id, l.name, l.public_description, l.address, l.timezone,
        l.phone, l.arrival_instructions,l.exit_instructions,l.road_directions_url,l.payment_instructions,l.cancellation_cutoff_hours,
        CASE WHEN EXISTS (SELECT 1 FROM parking_lot_layouts canonical
          WHERE canonical.location_id=l.id AND canonical.status='PUBLISHED' AND canonical.name LIKE $2)
          THEN 'ZONE_CAPACITY'
          WHEN l.assignment_mode='EXACT_SPOT' AND l.exact_mode_active THEN 'EXACT_SPOT' ELSE 'ZONE_CAPACITY' END assignment_mode,
        l.self_service_enabled,
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object('code', c.code, 'name', CASE WHEN c.code='BOBTAIL'
          THEN 'Bobtail' WHEN c.code='TRACTOR_TRAILER'
          AND EXISTS (SELECT 1 FROM parking_lot_layouts canonical WHERE canonical.location_id=l.id AND canonical.status='PUBLISHED' AND canonical.name LIKE 'Trucker Heaven physical lot ·%')
          THEN 'General Truck Parking' ELSE c.name END))
          FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) categories
      FROM parking_locations l
      LEFT JOIN parking_zones z ON z.location_id=l.id AND z.active AND z.public_visible
      LEFT JOIN parking_inventory i ON i.zone_id=z.id AND i.active
      LEFT JOIN parking_categories c ON c.id=i.category_id AND c.active AND c.code=ANY($1::text[])
      WHERE l.active
      GROUP BY l.id
      ORDER BY l.name`, [SUPPORTED_PUBLIC_CATEGORY_CODES, `${CANONICAL_LAYOUT_PREFIX}%`]);
    res.json({ locations: locations.rows });
  } catch (error) { next(error); }
});

router.get('/parking-areas', async (_req, res, next) => {
  try {
    const areas = await pool.query(`SELECT z.public_id id,z.name,z.description,z.display_order,
        l.public_id location_id,l.name location_name,l.timezone,l.phone,l.address,l.arrival_instructions,
        l.exit_instructions,l.road_directions_url,l.payment_instructions,l.cancellation_cutoff_hours,
        CASE WHEN EXISTS (SELECT 1 FROM parking_lot_layouts canonical
          WHERE canonical.location_id=l.id AND canonical.status='PUBLISHED' AND canonical.name LIKE $2)
          THEN 'ZONE_CAPACITY'
          WHEN l.assignment_mode='EXACT_SPOT' AND l.exact_mode_active THEN 'EXACT_SPOT' ELSE 'ZONE_CAPACITY' END assignment_mode,
        l.self_service_enabled,
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object('code', c.code, 'name', CASE WHEN c.code='BOBTAIL'
          THEN 'Bobtail' WHEN c.code='TRACTOR_TRAILER'
          AND EXISTS (SELECT 1 FROM parking_lot_layouts canonical WHERE canonical.location_id=l.id AND canonical.status='PUBLISHED' AND canonical.name LIKE 'Trucker Heaven physical lot ·%')
          THEN 'General Truck Parking' ELSE c.name END))
          FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) categories
      FROM parking_zones z
      JOIN parking_locations l ON l.id=z.location_id AND l.active
      JOIN parking_inventory i ON i.zone_id=z.id AND i.active
      JOIN parking_categories c ON c.id=i.category_id AND c.active AND c.code=ANY($1::text[])
      WHERE z.active AND z.public_visible
      GROUP BY z.id,l.id
      HAVING count(c.id) > 0
      ORDER BY l.name,z.display_order,z.id`, [SUPPORTED_PUBLIC_CATEGORY_CODES, `${CANONICAL_LAYOUT_PREFIX}%`]);
    res.json({ parkingAreas: areas.rows });
  } catch (error) { next(error); }
});

router.post('/availability', publicLimit(config.rateLimits.availability), async (req, res, next) => {
  try {
    const response = await withPendingExpiry(async client => {
      const request = await bookingInput(client, req.body);
      const values = await availability(client, request);
      await Promise.all(values.map(async value => { value.rateOffer = await publicRateOfferForInventory(client, request, value); }));
      const mapSelection = request.customerAssignmentMode === 'CUSTOMER_SELECTED_SPOT'
        ? await selectableSpaceStates(client, request, req.body.quoteToken)
        : await availabilityMapStates(client, request, values);
      return {
        timezone: request.location.timezone,
        results: publicAvailabilityResults(values, request),
        layout: await publishedLayout(client, request.locationId, null, mapSelection)
      };
    });
    res.json(response);
  } catch (error) { next(error); }
});

// Numbered spaces the driver can pick for the requested term and dates.
// '/monthly-positions' is the original name, kept for older clients.
router.post(['/positions', '/monthly-positions'], publicLimit(config.rateLimits.availability), async (req, res, next) => {
  try {
    const response = await withPendingExpiry(async client => {
      const request = await bookingInput(client, req.body);
      if (request.customerAssignmentMode !== 'CUSTOMER_SELECTED_SPOT') throw apiError('MONTHLY_TERM_REQUIRED', 'Choose Monthly Parking to select a numbered position.');
      const slots = await availability(client, request);
      // When every space is taken the lot is still returned, so the customer sees it full rather than an error.
      const selection = await selectableSpaceStates(client, request, req.body.quoteToken);
      return {
        assignmentMode: 'CUSTOMER_SELECTED_SPOT',
        available: slots.some(slot => slot.available),
        positions: selection.positions,
        layout: await publishedLayout(client, request.locationId, null, selection)
      };
    });
    res.json(response);
  } catch (error) { next(error); }
});

router.post('/quotes', publicLimit(config.rateLimits.quote), async (req, res, next) => {
  try {
    const response = await withPendingExpiry(async client => {
      const request = await bookingInput(client, req.body);
      const slots = await availability(client, request);
      const slot = slots.find(value => value.available);
      if (!slot) {
        const exactSlots = slots.filter(value => spotAssignmentMode(value.assignment_mode));
        if (exactSlots.length) {
          const offers = await Promise.all(exactSlots.map(value => publicRateOfferForInventory(client, request, value)));
          if (offers.every(offer => !offer.durations.some(duration => duration.code === request.duration))) {
            throw apiError('RATE_NOT_CONFIGURED', 'A rate is not configured for this parking selection', 409);
          }
          throw apiError('MONTHLY_POSITION_UNAVAILABLE', 'No parking space is available for these dates', 409);
        }
        throw apiError('PARKING_NOT_AVAILABLE', 'Parking is not available for these dates', 409);
      }
      // A driver switching spaces or refreshing a price gives up their previous hold first.
      if (req.body.previousQuoteToken) await releaseQuoteHold(client, req.body.previousQuoteToken);
      const preferredSpotId = selectedSpotId(req.body.selectedSpotId, { required: request.customerAssignmentMode === 'CUSTOMER_SELECTED_SPOT' });
      const spot = slot.assignment_mode === 'CUSTOMER_SELECTED_SPOT'
        ? await selectExactSpot(client, { slot, arrival: request.arrival, departure: request.departure, preferredSpotId })
        : null;
      const terms = publicTerms(request.location);
      if (!terms.available) throw apiError('TERMS_UNAVAILABLE', 'Parking terms are not configured for online booking', 409);
      const quote = { ...(await priceQuote(client, request, slot, { rateRuleId: spot?.rate_plan_id || null })), termsVersion: terms.version };
      const quoteToken = token(32);
      const expiresAt = new Date(Date.now() + config.bookingPolicy.quoteTtlSeconds * 1000).toISOString();
      const basisHash = await rateBasisHash(client, quote.rateRuleId, {
        parkingSpotId: spot?.id || null, inventoryId: slot.inventory_id,
        assignmentMode: slot.assignment_mode, duration: quote.duration
      });
      const protectedUntilAt = new Date(new Date(request.departure).getTime()
        + Number(slot.turnaround_buffer_minutes || 0) * 60000).toISOString();
      try {
        await client.query(`INSERT INTO parking_public_quotes(
          token_hash,request_hash,location_id,inventory_id,parking_spot_id,assignment_mode,rate_rule_id,
          arrival_at,departure_at,protected_until_at,pricing_snapshot,rate_basis_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
          digest(quoteToken), quoteRequestHash(request, slot.inventory_id, slot.assignment_mode, spot?.id || null),
          request.locationId, slot.inventory_id, spot?.id || null, slot.assignment_mode, quote.rateRuleId,
          request.arrival, request.departure, protectedUntilAt, JSON.stringify(quote), basisHash, expiresAt
        ]);
      } catch (error) {
        if (error.code === '23P01' && slot.assignment_mode === 'CUSTOMER_SELECTED_SPOT') {
          throw apiError('MONTHLY_POSITION_UNAVAILABLE', 'Another driver is holding that space. Choose another open space.', 409);
        }
        throw error;
      }
      return {
        quote: publicQuote(quote),
        quoteToken,
        expiresAt,
        categoryCode: slot.category_code,
        category: slot.category_name,
        parkingAreaId: request.canonicalLotRequest ? null : slot.zone_public_id,
        parkingArea: {
          id: slot.zone_public_id || null,
          name: publicCategoryName(slot.category_code, slot.category_name),
          instructions: customerParkingInstructions(slot.assignment_mode, slot.arrival_directions || request.location.arrival_instructions)
        },
        zone: request.canonicalLotRequest ? 'Trucker Heaven Parking' : (slot.public_visible ? slot.zone_name : 'Parking area'),
        arrival: slot.start,
        departure: request.duration === 'MONTHLY' ? null : slot.end,
        arrivalLocal: request.arrivalLocal,
        departureLocal: request.departureLocal,
        timezone: slot.timezone,
        assignmentMode: slot.assignment_mode,
        numberedSpacesAvailable: spotAssignmentMode(slot.assignment_mode) ? slot.available_spots : null,
        ...(spot ? {
          selectedMonthlyPosition: { id: Number(spot.id), label: spot.public_label },
          hold: { expiresAt, message: 'This space is held for you while you finish booking.' }
        } : {}),
        paymentInstructions: paymentInstructions(request.location),
        terms
      };
    });
    res.json(response);
  } catch (error) { next(error); }
});

async function releaseQuoteHold(db, quoteToken) {
  const released = await db.query(`UPDATE parking_public_quotes
    SET hold_released_at=COALESCE(hold_released_at,now()),hold_status='RELEASED'
    WHERE token_hash=$1 AND assignment_mode='CUSTOMER_SELECTED_SPOT'
      AND consumed_booking_id IS NULL AND checkout_booking_id IS NULL
    RETURNING id`, [digest(String(quoteToken))]);
  return released.rowCount > 0;
}

router.post('/quotes/release', publicLimit(config.rateLimits.quote), async (req, res, next) => {
  try {
    const quoteToken = String(req.body.quoteToken || '');
    if (!quoteToken) throw apiError('QUOTE_INVALID', 'The submitted quote is invalid', 409);
    res.json({ released: await releaseQuoteHold(pool, quoteToken) });
  } catch (error) { next(error); }
});

function bookingAccessCredential(idempotencyKey, customerEmail) {
  return digest(`parkingops-customer-access:v1:${idempotencyKey}:${customerEmail}:${config.cookie.tokenPepper}`);
}

function checkoutAttemptView(booking, credential = null) {
  return {
    publicToken: booking.public_token,
    reservationNumber: booking.reservation_number,
    parkingProduct: booking.parking_product,
    paymentStatus: booking.payment_status,
    reservationStatus: booking.status,
    authoritative: true,
    confirmed: booking.status === 'CONFIRMED' && ['PAID','DEMO_BYPASSED'].includes(booking.payment_status),
    financiallyPaid: booking.payment_status === 'PAID' || Boolean(booking.payment_confirmed_at),
    demo: booking.payment_status === 'DEMO_BYPASSED',
    ...(credential ? { lookupCredential: credential } : {})
  };
}

router.get('/payments/configuration', (_req, res) => {
  res.json({
    paymentMode: config.paymentMode,
    onlinePayment: !payOnSite(),
    checkoutConfigured: stripeGateway.checkoutConfigured(),
    stripeSecretConfigured: stripeGateway.configured(),
    webhookConfigured: stripeGateway.webhookConfigured(),
    customerReturnConfigured: config.customerAppUrlConfigured,
    documentStorageConfigured: privateDocumentStorage.configured(),
    mode: stripeGateway.mode(),
    currency: config.stripe.currency,
    paymentMethods: ['card']
  });
});

function privateDemoResponse(_req, res, next) {
  res.set({ 'Cache-Control': 'private, no-store, max-age=0, must-revalidate', Pragma: 'no-cache' });
  next();
}

router.post('/payments/demo/authorization', lookupLimit, privateDemoResponse, async (req, res, next) => {
  try {
    const authorization = await demoPaymentBypass.authorizationStatus(pool, req.body.token);
    res.json({ demoAuthorization: authorization });
  } catch (error) { next(error); }
});

router.post('/payments/demo/confirm', bookingLimit, privateDemoResponse, async (req, res, next) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const reservation = await demoPaymentBypass.completeAuthorization(client, req.body.token);
      await client.query('COMMIT');
      return res.json({ reservation });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '40001' && attempt < 2) continue;
      if (error.code === '40001') {
        return next(apiError('DEMO_AUTHORIZATION_CONFLICT', 'Demo authorization could not be consumed safely. Retry once.', 409));
      }
      return next(error);
    } finally { client.release(); }
  }
  return next(apiError('DEMO_AUTHORIZATION_CONFLICT', 'Demo authorization could not be consumed safely. Retry once.', 409));
});

function assertPublicCheckoutConfigured() {
  if (payOnSite()) throw apiError('ONLINE_PAYMENT_DISABLED', 'Online payment is not used. Book your parking and pay at Trucker Heaven.', 409);
  stripeGateway.assertCheckoutConfigured();
}

router.post('/booking-attempts', bookingLimit, async (req, res, next) => {
  const key = req.get('idempotency-key');
  if (!key || key.length < 16 || key.length > 200) return next(apiError('IDEMPOTENCY_KEY_REQUIRED', 'Submit with a valid idempotency key'));
  try { assertPublicCheckoutConfigured(req.body.duration); } catch (error) { return next(error); }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expirePendingBookings(client);
      await expireQuoteHolds(client);
      const request = await bookingInput(client, req.body);
      const customer = normalizedCustomer(req.body, { monthly: request.duration === 'MONTHLY' });
      const keyHash = digest(key);
      const scopeHash = digest(customer.email);
      const requestHash = idempotencyRequestHash(request, customer, req.body);
      const credential = bookingAccessCredential(key, customer.email);
      const duplicate = await bookingRecord(client, 'b.idempotency_hash=$1 AND b.idempotency_scope_hash=$2', keyHash, scopeHash).catch(() => null);
      if (duplicate) {
        if (duplicate.idempotency_request_hash !== requestHash) throw apiError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different booking attempt', 409);
        await client.query('COMMIT');
        return res.json({ bookingAttempt: checkoutAttemptView(duplicate, credential) });
      }
      if (req.body.termsAccepted !== true || req.body.cancellationTermsAccepted !== true) {
        throw apiError('TERMS_REQUIRED', 'Parking and cancellation terms must be accepted');
      }
      const terms = publicTerms(request.location);
      if (!terms.available) throw apiError('TERMS_UNAVAILABLE', 'Parking terms are not configured for online booking', 409);
      if (req.body.termsVersion != null && String(req.body.termsVersion) !== terms.version) {
        throw apiError('TERMS_VERSION_STALE', 'Parking terms changed. Review the current terms and try again.', 409);
      }
      const quoteToken = String(req.body.quoteToken || '');
      if (!quoteToken) throw apiError('QUOTE_REQUIRED', 'Request a current server price before checkout', 409);
      const quote = (await client.query(`SELECT * FROM parking_public_quotes WHERE token_hash=$1 FOR UPDATE`, [digest(quoteToken)])).rows[0];
      if (!quote || quote.consumed_booking_id || quote.checkout_booking_id || quote.hold_released_at
          || quote.hold_status !== 'ACTIVE' || new Date(quote.expires_at).getTime() <= Date.now()) {
        throw apiError('QUOTE_EXPIRED', 'This price or parking hold expired. Request a new quote.', 409);
      }
      const slots = await availability(client, request, { lock: true });
      const slot = slots.find(value => String(value.inventory_id) === String(quote.inventory_id)
        && (quote.assignment_mode === 'CUSTOMER_SELECTED_SPOT' || value.available));
      if (!slot) throw apiError(request.duration === 'MONTHLY' ? 'MONTHLY_POSITION_UNAVAILABLE' : 'PARKING_NOT_AVAILABLE',
        request.duration === 'MONTHLY' ? 'The selected monthly position is no longer available.' : 'Parking is no longer available for these dates', 409);
      const submittedSpotId = selectedSpotId(req.body.selectedSpotId, { required: quote.assignment_mode === 'CUSTOMER_SELECTED_SPOT' });
      if (quote.assignment_mode !== request.customerAssignmentMode
          || quote.request_hash !== quoteRequestHash(request, slot.inventory_id, quote.assignment_mode, quote.parking_spot_id)
          || String(quote.location_id) !== String(request.locationId)
          || new Date(quote.arrival_at).toISOString() !== request.arrival
          || new Date(quote.departure_at).toISOString() !== request.departure
          || (quote.assignment_mode === 'CUSTOMER_SELECTED_SPOT' && String(quote.parking_spot_id) !== String(submittedSpotId))) {
        throw apiError('QUOTE_REQUEST_MISMATCH', 'This quote does not match the booking attempt', 409);
      }
      if (await rateBasisHash(client, quote.rate_rule_id, {
        parkingSpotId: quote.parking_spot_id,
        inventoryId: quote.inventory_id,
        assignmentMode: quote.assignment_mode,
        duration: quote.pricing_snapshot?.duration
      }) !== quote.rate_basis_hash) throw apiError('QUOTE_STALE', 'The price configuration changed. Request a new quote.', 409);
      if (quote.assignment_mode === 'CUSTOMER_SELECTED_SPOT') {
        await selectExactSpot(client, {
          slot,
          arrival: request.arrival,
          departure: request.departure,
          preferredSpotId: quote.parking_spot_id,
          excludeQuoteId: quote.id
        });
      }
      const customerIdentity = await resolveOrCreateCustomer(client, customer);
      if (customerIdentity.conflict) {
        await client.query('COMMIT');
        const conflict = apiError('CUSTOMER_IDENTITY_CONFLICT',
          'The phone number and email are protected by different My Parking accounts. Verify an existing account or contact parking support.', 409);
        conflict.transactionFinalized = true;
        throw conflict;
      }
      const booking = (await client.query(`INSERT INTO parking_bookings(
          reservation_number,public_token,lookup_credential_hash,idempotency_hash,idempotency_scope_hash,idempotency_request_hash,
          inventory_id,location_id,category_id,status,assignment_mode_snapshot,pending_expires_at,arrival_at,departure_at,
          first_name,last_name,mobile_phone,email,company_name,usdot_number,tractor_unit_number,license_plate,
          license_plate_state,trailer_number,special_instructions,terms_accepted_at,cancellation_terms_accepted_at,
          parking_product,payment_status,customer_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,now(),now(),$25,'DRAFT',$26)
        RETURNING *`, [
        reservationNumber(), token(), await bcrypt.hash(credential, 12), keyHash, scopeHash, requestHash,
        slot.inventory_id, request.locationId, slot.category_id, slot.assignment_mode, quote.expires_at,
        request.arrival, request.bookingDeparture, customer.firstName, customer.lastName, customer.mobilePhone,
        customer.email, customer.companyName, customer.usdotNumber, customer.tractorUnitNumber,
        customer.licensePlate, customer.licensePlateState, customer.trailerNumber, customer.specialInstructions,
        request.duration, customerIdentity.customer.id
      ])).rows[0];
      await client.query('INSERT INTO parking_booking_price_snapshots(booking_id,snapshot) VALUES($1,$2)',
        [booking.id, JSON.stringify({ ...quote.pricing_snapshot, termsVersion: terms.version })]);
      const bound = await client.query(`UPDATE parking_public_quotes SET checkout_booking_id=$1
        WHERE id=$2 AND checkout_booking_id IS NULL AND consumed_booking_id IS NULL AND hold_status='ACTIVE'`, [booking.id, quote.id]);
      if (!bound.rowCount) throw apiError('QUOTE_ALREADY_USED', 'This quote is already bound to another checkout', 409);
      await client.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,reason,version)
        VALUES($1,'PENDING','CUSTOMER','Awaiting verified Stripe payment',1)`, [booking.id]);
      await client.query('COMMIT');
      return res.status(201).json({
        bookingAttempt: checkoutAttemptView(booking, credential),
        insuranceRequired: false,
        documentUploadOptional: request.duration === 'MONTHLY',
        hold: request.duration === 'MONTHLY' ? { expiresAt: quote.expires_at, selectedSpotId: Number(quote.parking_spot_id) } : null
      });
    } catch (error) {
      if (!error.transactionFinalized) await client.query('ROLLBACK').catch(() => {});
      if (['40001', '23505', '23P01'].includes(error.code) && attempt < 2) continue;
      return next(error);
    } finally { client.release(); }
  }
  return next(apiError('BOOKING_RETRY_EXHAUSTED', 'Please search availability again before checkout', 409));
});

router.post('/payments/stripe/checkout-sessions', bookingLimit, async (req, res, next) => {
  const key = req.get('idempotency-key');
  if (!key || key.length < 16 || key.length > 200) return next(apiError('IDEMPOTENCY_KEY_REQUIRED', 'Submit with a valid idempotency key'));
  try { assertPublicCheckoutConfigured(req.body.duration); } catch (error) { return next(error); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireQuoteHolds(client);
    const booking = await authorizedBooking(client, req.body.publicToken, req.body.lookupCredential, { lock: true });
    assertPublicCheckoutConfigured(booking.parking_product);
    if (booking.payment_status === 'CHECKOUT_PENDING' && booking.stripe_checkout_session_id && booking.stripe_checkout_url) {
      await client.query('COMMIT');
      return res.json({ checkout: {
        id: booking.stripe_checkout_session_id,
        url: booking.stripe_checkout_url,
        mode: booking.parking_product === 'MONTHLY' ? 'subscription' : 'payment',
        expiresAt: booking.stripe_checkout_expires_at || null
      } });
    }
    if (booking.payment_status !== 'DRAFT' || booking.status !== 'PENDING') {
      throw apiError('CHECKOUT_NOT_ALLOWED', 'This reservation is not eligible to start Checkout', 409);
    }
    const quote = (await client.query(`SELECT * FROM parking_public_quotes WHERE checkout_booking_id=$1 FOR UPDATE`, [booking.id])).rows[0];
    if (!quote || quote.hold_status !== 'ACTIVE' || quote.hold_released_at || quote.consumed_booking_id
        || new Date(quote.expires_at).getTime() <= Date.now()) {
      throw apiError('QUOTE_EXPIRED', 'The price or selected-space hold expired. Start again.', 409);
    }
    if (booking.parking_product === 'MONTHLY') {
      const slot = { location_id: booking.location_id, inventory_id: booking.inventory_id,
        turnaround_buffer_minutes: (await client.query('SELECT turnaround_buffer_minutes FROM parking_locations WHERE id=$1', [booking.location_id])).rows[0].turnaround_buffer_minutes,
        requested_duration: 'MONTHLY', timezone: 'UTC' };
      await selectExactSpot(client, { slot, arrival: booking.arrival_at, departure: booking.departure_at || monthlyOccupancyEnd(),
        preferredSpotId: quote.parking_spot_id, excludeQuoteId: quote.id });
    } else if (quote.parking_spot_id || booking.assignment_mode_snapshot !== 'ZONE_CAPACITY') {
      throw apiError('AREA_CAPACITY_EXACT_SPACE_FORBIDDEN', 'Daily and Weekly parking cannot select an exact space', 409);
    }
    const price = (await client.query('SELECT snapshot FROM parking_booking_price_snapshots WHERE booking_id=$1', [booking.id])).rows[0]?.snapshot;
    const amount = Number(price?.totalCents);
    if (!Number.isSafeInteger(amount) || amount < 50) throw apiError('PAYMENT_QUOTE_INVALID', 'The server-generated price is invalid', 409);
    const monthly = booking.parking_product === 'MONTHLY';
    const recurringAmount = monthly ? Number(price?.recurringUnitRateCents) : null;
    if (monthly && (!Number.isSafeInteger(recurringAmount) || recurringAmount < 50)) {
      throw apiError('PAYMENT_QUOTE_INVALID', 'The server-generated recurring price is invalid', 409);
    }
    const metadata = {
      parking_booking_id: String(booking.id),
      parking_quote_id: String(quote.id),
      parking_product: booking.parking_product,
      ...(monthly ? { selected_space_id: String(quote.parking_spot_id) } : {})
    };
    const customerAccount = booking.customer_id
      ? (await client.query('SELECT stripe_customer_id FROM parking_customers WHERE id=$1 FOR UPDATE', [booking.customer_id])).rows[0]
      : null;
    const requestedCheckoutExpiry = Math.floor(Date.now() / 1000) + config.stripe.checkoutTtlSeconds;
    const recurringProduct = { name: 'Monthly Parking', metadata: { parking_product: booking.parking_product } };
    // Stripe creates the one prorated invoice from now until the anchor. Do not
    // add a separate one-time item: that would charge the same period twice.
    const lineItems = monthly
      ? [{ quantity: 1, price_data: { currency: config.stripe.currency, unit_amount: recurringAmount,
        product_data: recurringProduct, recurring: { interval: 'month' } } }]
      : [{ quantity: 1, price_data: {
        currency: config.stripe.currency,
        unit_amount: amount,
        product_data: { name: `${booking.parking_product === 'WEEKLY' ? 'Weekly' : 'Daily'} Parking`, metadata: { parking_product: booking.parking_product } }
      } }];
    const billingCycleAnchor = monthly ? Math.floor(Date.parse(price?.nextBillingAt) / 1000) : null;
    if (monthly && (!Number.isSafeInteger(billingCycleAnchor) || billingCycleAnchor <= Math.floor(Date.now() / 1000))) {
      throw apiError('PAYMENT_QUOTE_INVALID', 'The server-generated next billing date is invalid', 409);
    }
    const session = await stripeGateway.createCheckoutSession({
      mode: monthly ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      client_reference_id: String(booking.id),
      ...(customerAccount?.stripe_customer_id
        ? { customer: customerAccount.stripe_customer_id }
        : { customer_email: booking.email, ...(monthly ? {} : { customer_creation: 'always' }) }),
      line_items: lineItems,
      metadata,
      ...(monthly ? { subscription_data: { metadata, billing_cycle_anchor: billingCycleAnchor } } : { payment_intent_data: { metadata } }),
      expires_at: requestedCheckoutExpiry,
      success_url: `${config.customerAppUrl}/#payment-return?reservation=${encodeURIComponent(booking.public_token)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.customerAppUrl}/#checkout-cancelled?reservation=${encodeURIComponent(booking.public_token)}`
    }, `parkingops-checkout:${booking.id}`);
    if (!session?.id || !session?.url) throw apiError('STRIPE_CHECKOUT_FAILED', 'Stripe did not return a usable Checkout Session', 502);
    const checkoutExpirySeconds = Number(session.expires_at || requestedCheckoutExpiry);
    if (!Number.isSafeInteger(checkoutExpirySeconds) || checkoutExpirySeconds <= Math.floor(Date.now() / 1000)) {
      throw apiError('STRIPE_CHECKOUT_FAILED', 'Stripe returned an invalid Checkout Session expiry', 502);
    }
    const checkoutExpiresAt = new Date(checkoutExpirySeconds * 1000).toISOString();
    const localHoldExpiresAt = new Date((checkoutExpirySeconds + config.stripe.webhookGraceSeconds) * 1000).toISOString();
    await client.query(`UPDATE parking_bookings SET payment_status='CHECKOUT_PENDING',stripe_checkout_session_id=$2,
      stripe_checkout_url=$3,stripe_checkout_expires_at=$4,pending_expires_at=$5,checkout_created_at=now(),updated_at=now()
      WHERE id=$1`, [booking.id, session.id, session.url, checkoutExpiresAt, localHoldExpiresAt]);
    await client.query(`UPDATE parking_public_quotes SET checkout_hold_expires_at=$2
      WHERE id=$1 AND hold_status='ACTIVE' AND consumed_booking_id IS NULL`, [quote.id, localHoldExpiresAt]);
    await client.query('COMMIT');
    res.status(201).json({ checkout: {
      id: session.id,
      url: session.url,
      mode: monthly ? 'subscription' : 'payment',
      expiresAt: checkoutExpiresAt
    } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/payments/status', lookupLimit, async (req, res, next) => {
  try {
    const booking = await authorizedBooking(pool, req.body.publicToken, req.body.lookupCredential);
    res.json({ booking: checkoutAttemptView(booking), billing: {
      subscriptionStatus: booking.subscription_status,
      paidThrough: booking.billing_period_end_at,
      graceEndsAt: booking.payment_grace_ends_at,
      manageBillingAvailable: booking.parking_product === 'MONTHLY' && Boolean(booking.stripe_customer_id)
    } });
  } catch (error) { next(error); }
});

router.post('/payments/stripe/portal-sessions', lookupLimit, async (req, res, next) => {
  try {
    const booking = await authorizedBooking(pool, req.body.publicToken, req.body.lookupCredential);
    if (booking.parking_product !== 'MONTHLY' || !booking.stripe_customer_id || !booking.payment_confirmed_at) {
      throw apiError('BILLING_PORTAL_NOT_AVAILABLE', 'Manage Billing is available for active Monthly customers', 409);
    }
    const session = await stripeGateway.createPortalSession({
      customer: booking.stripe_customer_id,
      return_url: `${config.customerAppUrl}/#manage?reservation=${encodeURIComponent(booking.public_token)}`
    }, `parkingops-portal:${booking.id}:${Date.now().toString().slice(0, -4)}`);
    res.json({ portal: { url: session.url, temporary: true } });
  } catch (error) { next(error); }
});

router.post('/bookings', bookingLimit, async (req, res, next) => {
  // Pay-on-site is the production booking path. The legacy test database keeps
  // using this route for its existing contract tests in either mode.
  const directTestBooking = process.env.PARKING_TEST_DATABASE === 'parkingops_test'
    && String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test');
  if (!payOnSite() && !directTestBooking) return next(apiError('PAYMENT_CHECKOUT_REQUIRED', 'Create a Stripe Checkout Session to pay and confirm parking.', 409));
  const key = req.get('idempotency-key');
  if (!key || key.length < 16 || key.length > 200) return next(apiError('IDEMPOTENCY_KEY_REQUIRED', 'Submit with a valid idempotency key'));
  let customer;
  try {
    customer = normalizedCustomer(req.body, { monthly: String(req.body.duration || '').trim().toUpperCase() === 'MONTHLY' });
  } catch (error) { return next(error); }
  const keyHash = digest(key);
  const scopeHash = digest(customer.email);
  let exactModeAttempt = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expirePendingBookings(client);
      await expireQuoteHolds(client);
      const request = await bookingInput(client, req.body);
      const requestHash = idempotencyRequestHash(request, customer, req.body);
      const duplicate = await bookingRecord(client, 'b.idempotency_hash=$1 AND b.idempotency_scope_hash=$2', keyHash, scopeHash).catch(() => null);
      if (duplicate) {
        if (duplicate.idempotency_request_hash && duplicate.idempotency_request_hash !== requestHash) {
          throw apiError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different booking request', 409);
        }
        await attachPublicMap(client, duplicate);
        await client.query('COMMIT');
        return res.status(200).json({ booking: expose(duplicate) });
      }
      const slots = await availability(client, request, { lock: true });
      let persistedQuote = null;
      if (req.body.quoteToken) {
        const quoteResult = await client.query(`SELECT * FROM parking_public_quotes
          WHERE token_hash=$1 FOR UPDATE`, [digest(String(req.body.quoteToken))]);
        if (!quoteResult.rowCount) throw apiError('QUOTE_INVALID', 'The submitted quote is invalid', 409);
        persistedQuote = quoteResult.rows[0];
        if (persistedQuote.consumed_booking_id) throw apiError('QUOTE_ALREADY_USED', 'This quote has already been used', 409);
        if (new Date(persistedQuote.expires_at).getTime() <= Date.now()) throw apiError('QUOTE_EXPIRED', 'This quote has expired. Request a new quote.', 409);
        if (persistedQuote.hold_released_at) throw apiError('QUOTE_EXPIRED', 'The hold on your space was released. Choose a space again.', 409);
      }
      const slot = persistedQuote
        ? slots.find(value => String(value.inventory_id) === String(persistedQuote.inventory_id)
          && (persistedQuote.assignment_mode === 'CUSTOMER_SELECTED_SPOT' || value.available))
        : slots.find(value => value.available);
      if (!slot) {
        if (slots.some(value => spotAssignmentMode(value.assignment_mode))) throw apiError('MONTHLY_POSITION_UNAVAILABLE', 'That space was just taken. Choose another open space.', 409);
        throw apiError('PARKING_NOT_AVAILABLE', 'Parking is no longer available for these dates', 409);
      }
      exactModeAttempt = spotAssignmentMode(slot.assignment_mode);
      if (req.body.termsAccepted !== true || req.body.cancellationTermsAccepted !== true) {
        throw apiError('TERMS_REQUIRED', 'Parking and cancellation terms must be accepted');
      }
      const terms = publicTerms(request.location);
      if (!terms.available) throw apiError('TERMS_UNAVAILABLE', 'Parking terms are not configured for online booking', 409);
      // Existing API clients did not send a version. Keep that wire contract
      // compatible while binding every version-aware customer acceptance.
      if (req.body.termsVersion != null && String(req.body.termsVersion) !== terms.version) throw apiError('TERMS_VERSION_STALE', 'Parking terms changed. Review the current terms and try again.', 409);
      let selectedSpot = null;
      let quote;
      if (slot.assignment_mode === 'CUSTOMER_SELECTED_SPOT' && !persistedQuote) {
        throw apiError('QUOTE_REQUIRED', 'Choose a parking space on the map before booking.', 409);
      }
      if (persistedQuote) {
        const submittedSpotId = selectedSpotId(req.body.selectedSpotId, { required: slot.assignment_mode === 'CUSTOMER_SELECTED_SPOT' });
        if (persistedQuote.assignment_mode !== slot.assignment_mode
          || persistedQuote.request_hash !== quoteRequestHash(request, slot.inventory_id, slot.assignment_mode, persistedQuote.parking_spot_id)
          || String(persistedQuote.location_id) !== String(request.locationId)
          || new Date(persistedQuote.arrival_at).toISOString() !== request.arrival
          || new Date(persistedQuote.departure_at).toISOString() !== request.departure
          || (slot.assignment_mode === 'CUSTOMER_SELECTED_SPOT'
            && String(persistedQuote.parking_spot_id) !== String(submittedSpotId))) {
          throw apiError('QUOTE_REQUEST_MISMATCH', 'This quote does not match the booking request', 409);
        }
        if (await rateBasisHash(client, persistedQuote.rate_rule_id, {
          parkingSpotId: persistedQuote.parking_spot_id,
          inventoryId: persistedQuote.inventory_id,
          assignmentMode: persistedQuote.assignment_mode,
          duration: persistedQuote.pricing_snapshot?.duration || durationFor(request.arrival, request.departure, request.location.timezone)
        }) !== persistedQuote.rate_basis_hash) {
          throw apiError('QUOTE_STALE', 'The price configuration changed. Request a new quote.', 409);
        }
        if (slot.assignment_mode === 'CUSTOMER_SELECTED_SPOT') {
          selectedSpot = await selectExactSpot(client, {
            slot,
            arrival: request.arrival,
            departure: request.departure,
            preferredSpotId: persistedQuote.parking_spot_id,
            excludeQuoteId: persistedQuote.id
          });
        }
        quote = { ...persistedQuote.pricing_snapshot, termsVersion: terms.version };
      } else {
        quote = { ...(await priceQuote(client, request, slot, { rateRuleId: selectedSpot?.rate_plan_id || null })), termsVersion: terms.version };
      }
      const credential = token(24);
      const status = request.location.booking_approval_mode === 'MANUAL_CONFIRM' ? 'PENDING' : 'CONFIRMED';
      let customerId = null;
      if (payOnSite()) {
        const customerIdentity = await resolveOrCreateCustomer(client, customer);
        if (customerIdentity.conflict) {
          throw apiError('CUSTOMER_IDENTITY_CONFLICT',
            'This phone number and email belong to different customer records. Call Trucker Heaven parking to finish your reservation.', 409);
        }
        if (customerIdentity.customer.status === 'SUSPENDED') {
          throw apiError('CUSTOMER_ACCOUNT_SUSPENDED', 'Please call Trucker Heaven parking to make a reservation.', 409);
        }
        customerId = customerIdentity.customer.id;
      }
      // Monthly parking is open-ended (billed on the 1st) in pay-on-site mode.
      const storedDeparture = payOnSite() ? request.bookingDeparture : request.departure;
      const booking = (await client.query(`INSERT INTO parking_bookings(
          reservation_number, public_token, lookup_credential_hash, idempotency_hash, idempotency_scope_hash, idempotency_request_hash,
          inventory_id, location_id, category_id, status, assignment_mode_snapshot, requested_parking_spot_id, pending_expires_at, arrival_at, departure_at,
          first_name, last_name, mobile_phone, email, company_name, tractor_unit_number, license_plate,
          license_plate_state, trailer_number, special_instructions, terms_accepted_at, cancellation_terms_accepted_at,
          parking_product,payment_status,usdot_number,customer_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,now(),now(),$26,'NOT_REQUIRED',$27,$28)
        RETURNING *`, [
        reservationNumber(), token(), await bcrypt.hash(credential, 12), keyHash, scopeHash, requestHash,
        slot.inventory_id, request.locationId, slot.category_id, status, slot.assignment_mode,
        status === 'PENDING' ? selectedSpot?.id || null : null, status === 'PENDING' ? pendingExpiryAt() : null,
        request.arrival, storedDeparture,
        customer.firstName, customer.lastName, customer.mobilePhone, customer.email, customer.companyName,
        customer.tractorUnitNumber, customer.licensePlate, customer.licensePlateState,
        customer.trailerNumber, customer.specialInstructions, request.duration,
        customer.usdotNumber || null, customerId
      ])).rows[0];
      if (persistedQuote) {
        const consumed = await client.query(`UPDATE parking_public_quotes SET consumed_booking_id=$1
          WHERE id=$2 AND consumed_booking_id IS NULL`, [booking.id, persistedQuote.id]);
        if (!consumed.rowCount) throw apiError('QUOTE_ALREADY_USED', 'This quote has already been used', 409);
      }
      let assignment = null;
      if (slot.assignment_mode === 'CUSTOMER_SELECTED_SPOT' && status === 'CONFIRMED') {
        assignment = await assignSelectedExactSpot(client, {
          booking,
          slot,
          spot: selectedSpot,
          source: 'CUSTOMER_SELECTED',
          reason: 'Customer-selected parking space'
        });
        booking.assigned_zone_id = assignment.zone_id;
        booking.assigned_spot_label = assignment.public_label;
      }
      await client.query('INSERT INTO parking_booking_price_snapshots(booking_id,snapshot) VALUES($1,$2)', [booking.id, JSON.stringify(quote)]);
      await client.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,reason,version)
        VALUES($1,$2,'CUSTOMER',$3,1)`, [booking.id, status,
        status === 'CONFIRMED' ? 'Automatically confirmed pay-at-location booking' : 'Customer booking submitted for manual approval']);
      if (status === 'CONFIRMED' && customerId) {
        await activateCustomerFromBooking(client, { ...booking, category_code: slot.category_code });
        await ensureOnSiteCharges(client, booking);
        await customerNotifications.enqueueForBooking(client, booking, 'RESERVATION_CONFIRMED', {
          manageUrl: `${config.customerAppUrl.replace(/\/$/, '')}/#r=${encodeURIComponent(booking.reservation_number)}&c=${encodeURIComponent(credential)}`
        });
      }
      const publicMap = spotAssignmentMode(slot.assignment_mode) && assignment
        ? await publishedLayout(client, booking.location_id, assignment.parking_spot_id)
        : await publishedLayout(client, booking.location_id, null, null, {
          inventoryId: booking.inventory_id,
          name: publicCategoryName(slot.category_code, slot.category_name),
          instructions: customerParkingInstructions(slot.assignment_mode, slot.arrival_directions || request.location.arrival_instructions),
          arrival: booking.arrival_at,
          departure: booking.departure_at
        });
      await client.query('COMMIT');
      return res.status(201).json({ booking: expose({
        ...booking,
        location_name: request.location.name,
        address: request.location.address,
        phone: request.location.phone,
        timezone: request.location.timezone,
        zone_name: slot.zone_name,
        zone_public_id: slot.zone_public_id,
        category_code: slot.category_code,
        category_name: slot.category_name,
        arrival_instructions: request.location.arrival_instructions,
        area_arrival_directions: slot.arrival_directions,
        area_exit_directions: slot.exit_directions,
        exit_instructions: request.location.exit_instructions,
        road_directions_url: request.location.road_directions_url,
        payment_instructions: paymentInstructions(request.location),
        cancellation_cutoff_hours: request.location.cancellation_cutoff_hours,
        assignment_mode_snapshot: slot.assignment_mode,
        exact_mode_active: request.location.exact_mode_active,
        self_service_enabled: request.location.self_service_enabled,
        check_in_early_minutes: request.location.check_in_early_minutes,
        check_in_late_minutes: request.location.check_in_late_minutes,
        snapshot: quote,
        customer_notes: [],
        public_map: publicMap
      }, credential) });
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error.code === '40001' || error.code === '23505' || error.code === '23P01') && attempt < 2) continue;
      if (error.code === '40001' || error.code === '23505' || error.code === '23P01') {
        return next(exactModeAttempt
          ? apiError('MONTHLY_POSITION_UNAVAILABLE', 'The selected monthly position is no longer available. Choose another position.', 409)
          : apiError('PARKING_NOT_AVAILABLE', 'Parking is no longer available for these dates', 409));
      }
      return next(error);
    } finally { client.release(); }
  }
  return next(apiError('BOOKING_RETRY_EXHAUSTED', 'Please search availability again before booking', 409));
});

router.post('/bookings/lookup', lookupLimit, async (req, res, next) => {
  try {
    const booking = await withPendingExpiry(async client => {
      const reservationNumberValue = String(req.body.reservationNumber || '').trim().toUpperCase();
      const credential = String(req.body.lookupCredential || '');
      const found = await bookingRecord(client, 'b.reservation_number=$1', reservationNumberValue);
      if (!found || !(await bcrypt.compare(credential, found.lookup_credential_hash))) {
        throw apiError('BOOKING_NOT_FOUND', 'Booking not found', 404);
      }
      return attachPublicMap(client, found);
    });
    res.json({ booking: expose(booking) });
  } catch (error) { next(error); }
});

router.post('/bookings/:token/cancel', lookupLimit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expirePendingBookings(client);
    const locked = await client.query('SELECT id FROM parking_bookings WHERE public_token=$1 FOR UPDATE', [req.params.token]);
    if (!locked.rowCount) throw apiError('BOOKING_NOT_FOUND', 'Booking not found', 404);
    const booking = await bookingRecord(client, 'b.id=$1', locked.rows[0].id);
    if (!(await bcrypt.compare(String(req.body.lookupCredential || ''), booking.lookup_credential_hash))) {
      throw apiError('BOOKING_NOT_FOUND', 'Booking not found', 404);
    }
    if (booking.status === 'CANCELLED') {
      await client.query('COMMIT');
      return res.json({ booking: expose(booking), idempotent: true });
    }
    if (booking.parking_product === 'MONTHLY' && (booking.stripe_subscription_id || booking.stripe_customer_id)) {
      throw apiError('MANAGE_MONTHLY_BILLING', 'Manage recurring Monthly cancellation through the secure billing portal', 409);
    }
    const cutoff = new Date(booking.arrival_at).getTime() - Number(booking.cancellation_cutoff_hours || 0) * 3600000;
    if (Date.now() >= cutoff || !['PENDING', 'CONFIRMED'].includes(booking.status)) {
      throw apiError('CANCELLATION_NOT_ELIGIBLE', 'This booking is not eligible for online cancellation', 409);
    }
    assertTransition(booking.status, 'CANCELLED');
    await client.query(`UPDATE parking_bookings SET status='CANCELLED', pending_expires_at=NULL,
      version=version+1, updated_at=now() WHERE id=$1`, [booking.id]);
    await client.query(`INSERT INTO parking_booking_status_history
      (booking_id,previous_status,new_status,actor_type,reason,version)
      VALUES($1,$2,'CANCELLED','CUSTOMER',$3,$4)`, [booking.id, booking.status,
      cleanText(req.body.reason, 300, 'Reason') || 'Customer cancellation', Number(booking.version) + 1]);
    await releaseCurrentAssignment(client, booking.id, 'Customer cancellation');
    const refreshed = await bookingRecord(client, 'b.id=$1', booking.id);
    await customerNotifications.enqueueForBooking(client, refreshed, 'CANCELLATION_CONFIRMED');
    await client.query('COMMIT');
    res.json({ booking: expose(refreshed) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

async function secureBooking(client, tokenValue, credential, { lock = false } = {}) {
  const locked = await client.query(`SELECT id FROM parking_bookings WHERE public_token=$1${lock ? ' FOR UPDATE' : ''}`, [tokenValue]);
  if (!locked.rowCount) throw apiError('BOOKING_NOT_FOUND', 'Booking not found', 404);
  const booking = await bookingRecord(client, 'b.id=$1', locked.rows[0].id);
  if (!(await bcrypt.compare(String(credential || ''), booking.lookup_credential_hash))) {
    throw apiError('BOOKING_NOT_FOUND', 'Booking not found', 404);
  }
  return booking;
}

router.post('/bookings/:token/check-in', lookupLimit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expirePendingBookings(client);
    let booking = await secureBooking(client, req.params.token, req.body.lookupCredential, { lock: true });
    if (booking.status === 'CHECKED_IN' && booking.actual_arrival_at) {
      await attachPublicMap(client, booking);
      await client.query('COMMIT');
      return res.json({ booking: expose(booking), idempotent: true });
    }
    if (booking.status !== 'CONFIRMED'
      || (spotAssignmentMode(bookingAssignmentMode(booking)) && !booking.parking_spot_id)
      || !booking.self_service_enabled) {
      throw apiError('RESERVATION_NOT_CHECKIN_ELIGIBLE', 'This reservation is not eligible for customer check-in', 409);
    }
    const earliest = new Date(booking.arrival_at).getTime() - Number(booking.check_in_early_minutes || 0) * 60000;
    const latest = new Date(booking.arrival_at).getTime() + Number(booking.check_in_late_minutes || 0) * 60000;
    if (Date.now() < earliest) throw apiError('ARRIVAL_TOO_EARLY', 'Check-in is not open yet for this reservation', 409);
    if (Date.now() > latest || (booking.departure_at && Date.now() >= new Date(booking.departure_at).getTime())) {
      throw apiError('RESERVATION_NOT_CHECKIN_ELIGIBLE', 'The customer check-in window has closed', 409);
    }
    assertTransition(booking.status, 'CHECKED_IN');
    await client.query(`UPDATE parking_bookings SET status='CHECKED_IN',actual_arrival_at=now(),version=version+1,updated_at=now()
      WHERE id=$1`, [booking.id]);
    await client.query(`INSERT INTO parking_booking_status_history
      (booking_id,previous_status,new_status,actor_type,reason,version)
      VALUES($1,$2,'CHECKED_IN','CUSTOMER','Customer self check-in',$3)`, [booking.id, booking.status, Number(booking.version) + 1]);
    if (spotAssignmentMode(bookingAssignmentMode(booking))) await recordAssignmentArrival(client, booking.id);
    booking = await bookingRecord(client, 'b.id=$1', booking.id);
    await attachPublicMap(client, booking);
    await client.query('COMMIT');
    res.json({ booking: expose(booking) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.post('/bookings/:token/check-out', lookupLimit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let booking = await secureBooking(client, req.params.token, req.body.lookupCredential, { lock: true });
    if (['CHECKED_OUT', 'COMPLETED'].includes(booking.status) && booking.actual_departure_at) {
      await attachPublicMap(client, booking);
      await client.query('COMMIT');
      return res.json({ booking: expose(booking), idempotent: true });
    }
    if (booking.status !== 'CHECKED_IN'
      || (spotAssignmentMode(bookingAssignmentMode(booking)) && !booking.parking_spot_id)
      || !booking.self_service_enabled) {
      throw apiError('RESERVATION_NOT_CHECKOUT_ELIGIBLE', 'Check in before recording departure', 409);
    }
    assertTransition(booking.status, 'CHECKED_OUT');
    await client.query(`UPDATE parking_bookings SET status='CHECKED_OUT',actual_departure_at=now(),version=version+1,updated_at=now()
      WHERE id=$1`, [booking.id]);
    await client.query(`INSERT INTO parking_booking_status_history
      (booking_id,previous_status,new_status,actor_type,reason,version)
      VALUES($1,$2,'CHECKED_OUT','CUSTOMER','Customer self check-out',$3)`, [booking.id, booking.status, Number(booking.version) + 1]);
    if (spotAssignmentMode(bookingAssignmentMode(booking))) {
      await recordAssignmentDeparture(client, booking.id);
      await releaseCurrentAssignment(client, booking.id, 'Customer self check-out');
    }
    booking = await bookingRecord(client, 'b.id=$1', booking.id);
    await client.query('COMMIT');
    res.json({ booking: expose(booking) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

module.exports = router;
