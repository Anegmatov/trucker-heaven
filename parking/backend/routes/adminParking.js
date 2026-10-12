const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { DateTime } = require('luxon');
const pool = require('../db');
const { requireAdmin, csrf, permit } = require('../auth');
const { apiError, cleanText, email, phone } = require('../utils');
const { assertTransition, capacityBlockingStatuses, expirePendingBookings } = require('../services/bookingWorkflow');
const { currentAssignment, releaseCurrentAssignment, recordAssignmentArrival, recordAssignmentDeparture,
  eligibleReassignmentSpots, reassignSpot, setupChecklist, liveLot, BLOCKING_STATUSES } = require('../services/exactSpaceService');
const liveLotReadModel = require('../services/liveLotReadModel');
const { publishDraftSnapshot, protectAssignedSpaces } = require('../services/layoutPublication');
const { areaCapacityMetrics, lockInventoryIds, assertFinalBookingAvailability } = require('../services/parkingService');
const { selectExactSpot, assignSelectedExactSpot } = require('../services/exactSpaceService');
const { monthlyOccupancyEnd } = require('../services/bookingPolicy');
const { CANONICAL_LAYOUT_PREFIX, resolveCanonicalLot } = require('../services/canonicalLot');
const canonicalLayoutMaintenance = require('../services/canonicalLayoutMaintenance');
const { eligibilityErrors } = require('../services/spaceProductEligibility');
const customerIdentity = require('../services/customerIdentity');
const stripeGateway = require('../services/stripeGateway');
const { payOnSite, confirmOnSiteBooking } = require('../services/onSiteBooking');
const { isOpenEndedWeekly } = require('../services/weeklyParking');

const router = express.Router();
router.use(requireAdmin);

const roles = {
  read: permit('STAFF'),
  operate: permit('STAFF'),
  configure: permit('OWNER'),
  owner: permit('OWNER')
};
const bookingStatuses = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'];
const config = {
  locations: { table: 'parking_locations', columns: ['name', 'public_description', 'address', 'timezone', 'phone', 'business_hours', 'arrival_instructions', 'exit_instructions', 'road_directions_url', 'booking_approval_mode', 'payment_instructions', 'cancellation_cutoff_hours', 'assignment_mode', 'self_service_enabled', 'check_in_early_minutes', 'check_in_late_minutes', 'turnaround_buffer_minutes', 'active'] },
  zones: { table: 'parking_zones', columns: ['location_id', 'name', 'description', 'operational_notes', 'arrival_directions', 'exit_directions', 'display_order', 'active', 'public_visible'] },
  inventory: { table: 'parking_inventory', columns: ['zone_id', 'category_id', 'capacity', 'public_description', 'restrictions', 'public_remaining_capacity', 'active'] },
  rates: { table: 'parking_rate_rules', columns: ['location_id', 'zone_id', 'category_id', 'daily_rate_cents', 'weekly_rate_cents', 'monthly_rate_cents', 'fee_cents', 'tax_basis_points', 'starts_at', 'ends_at', 'priority', 'active'] },
  closures: { table: 'parking_closures', columns: ['location_id', 'zone_id', 'inventory_id', 'category_id', 'closure_type', 'capacity_reduction', 'starts_at', 'ends_at', 'reason', 'internal_note', 'customer_message', 'active'] },
  categories: { table: 'parking_categories', columns: ['code', 'name', 'active'] }
};
const canonicalParkingCategories = [
  ['TRACTOR_TRAILER', 'Tractor + Trailer'],
  ['BOBTAIL', 'Bobtail'],
  ['TRAILER_ONLY', 'Trailer Only'],
  ['TRACTOR_ONLY', 'Tractor Only']
];
const parkingUses = ['CUSTOMER', 'DAILY', 'WEEKLY', 'MONTHLY', 'COMPANY', 'SHOP', 'SHOP_BOBTAIL', 'CUSTOMER_BOBTAIL', 'INTERNAL', 'NEEDS_CLASSIFICATION'];
const classificationStates = ['COMPLETE', 'NEEDS_CLASSIFICATION'];
const spacePurposes = ['CUSTOMER', 'SHOP', 'COMPANY', 'INTERNAL', 'UNRESOLVED'];
const simplifiedSpaceTypes = ['BOBTAIL', 'GENERAL_TRUCK', 'SHOP', 'COMPANY', 'INTERNAL', 'UNRESOLVED'];
const canonicalLayoutNamePrefix = CANONICAL_LAYOUT_PREFIX;

function pageLimit(value, fallback = 50, maximum = 100) {
  return Math.min(wholeNumber(value === undefined || value === '' ? fallback : value, 'Page limit', { min: 1 }), maximum);
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value, requiredKeys) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed || requiredKeys.some(key => parsed[key] === undefined || parsed[key] === null || parsed[key] === '')) throw new Error('missing key');
    return parsed;
  } catch (_) { throw apiError('INVALID_CURSOR', 'The pagination cursor is invalid', 400); }
}

function localDate(value, label) {
  const parsed = DateTime.fromISO(String(value || ''), { setZone: false });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) || !parsed.isValid) throw apiError('VALIDATION_ERROR', `${label} must be YYYY-MM-DD`);
  return String(value);
}

function realLotText(value, label, max = 160) { return cleanText(value, max, label, true); }
function realLotUse(value) {
  const use = String(value || '').trim().toUpperCase();
  if (!parkingUses.includes(use)) throw apiError('VALIDATION_ERROR', 'Choose a valid parking use');
  return use;
}
function realLotClassification(value) {
  const state = String(value || '').trim().toUpperCase();
  if (!classificationStates.includes(state)) throw apiError('VALIDATION_ERROR', 'Choose a valid classification state');
  return state;
}

function spacePurpose(value) {
  const purpose = String(value || '').trim().toUpperCase();
  if (!spacePurposes.includes(purpose)) throw apiError('VALIDATION_ERROR', 'Choose a valid parking purpose');
  return purpose;
}

function simplifiedSpaceType(value) {
  const type = String(value || '').trim().toUpperCase();
  if (!simplifiedSpaceTypes.includes(type)) throw apiError('VALIDATION_ERROR', 'Choose Bobtail, General Truck, Shop, Company, or Unresolved');
  return type;
}

function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') throw apiError('VALIDATION_ERROR', `${label} must be true or false`);
  return value;
}

function rightAngle(value) {
  const rotation = layoutRotation(value);
  if (Math.abs(rotation / 90 - Math.round(rotation / 90)) > Number.EPSILON) {
    throw apiError('VALIDATION_ERROR', 'Spaces can only be rotated in 90-degree increments');
  }
  return rotation;
}

function canonicalLayoutMaintenanceEnabled() {
  return canonicalLayoutMaintenance.enabled();
}

async function hasCanonicalPhysicalLayout(client, locationId) {
  const result = await client.query(`SELECT EXISTS(
    SELECT 1 FROM parking_lot_layouts
    WHERE location_id=$1 AND name LIKE $2
  ) canonical`, [locationId, `${canonicalLayoutNamePrefix}%`]);
  return Boolean(result.rows[0].canonical);
}

async function rejectCanonicalExactAssignment(client, locationId, requestedMode) {
  if (requestedMode !== 'EXACT_SPOT' || !await hasCanonicalPhysicalLayout(client, locationId)) return;
  throw apiError('CANONICAL_AREA_BOOKING_REQUIRED',
    'Trucker Heaven customer parking uses highlighted parking areas and cannot assign an exact numbered space.', 409);
}

async function requireCanonicalLayoutMaintenance(client, locationId) {
  if (!await hasCanonicalPhysicalLayout(client, locationId) || canonicalLayoutMaintenanceEnabled()) return;
  throw apiError('CANONICAL_LAYOUT_LOCKED',
    'The Trucker Heaven physical map is locked. Structural changes require PARKING_CANONICAL_LAYOUT_MAINTENANCE=true during an approved maintenance window.', 423);
}

async function requireCanonicalPublicationMaintenance(client, locationId, draftLayoutId) {
  if (!await hasCanonicalPhysicalLayout(client, locationId) || canonicalLayoutMaintenanceEnabled()) return;
  if (await canonicalLayoutMaintenance.structuralChanges(client, draftLayoutId, locationId)) {
    await requireCanonicalLayoutMaintenance(client, locationId);
  }
}

function version(body) {
  const value = Number(body.version);
  if (!Number.isInteger(value) || value < 1) throw apiError('BOOKING_VERSION_CONFLICT', 'A current version is required', 409);
  return value;
}

function adminUserVersion(body) {
  const value = Number(body.version);
  if (!Number.isInteger(value) || value < 1) throw apiError('ADMIN_USER_VERSION_CONFLICT', 'A current user version is required', 409);
  return value;
}

async function audit(req, action, entityType, entityId, metadata = {}, client = pool) {
  await client.query(`INSERT INTO parking_audit_events(admin_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,$2,$3,$4,$5)`, [req.admin.id, action, entityType, String(entityId), JSON.stringify(metadata)]);
}

function wholeNumber(value, label, { min = 0, optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) throw apiError('VALIDATION_ERROR', `${label} must be a whole number${min ? ` of at least ${min}` : ''}`);
  return number;
}

function validTime(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw apiError('VALIDATION_ERROR', `${label} must be a valid timestamp`);
  return time.toISOString();
}

function requireNarrative(body, target) {
  const reason = cleanText(body.reason, 300, 'Reason');
  const note = cleanText(body.note, 1000, 'Note');
  if (!reason && !note) throw apiError('VALIDATION_ERROR', `Provide a reason or note for ${target.toLowerCase().replace('_', ' ')}`);
  if (['CANCELLED', 'NO_SHOW'].includes(target) && !reason) throw apiError('VALIDATION_ERROR', `A reason is required to mark a booking ${target.toLowerCase().replace('_', ' ')}`);
  return { reason, note };
}

async function expirePendingNow() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expirePendingBookings(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function capacityStatuses() { return capacityBlockingStatuses(); }

async function affectedBookings(client, closure) {
  const result = await client.query(`SELECT b.id,b.reservation_number,b.status,b.arrival_at,b.departure_at
    FROM parking_bookings b
    JOIN parking_inventory i ON i.id=b.inventory_id
    JOIN parking_zones z ON z.id=i.zone_id
    WHERE b.status=ANY($1::text[]) AND b.arrival_at<$2 AND b.departure_at>$3
      AND (($4::bigint IS NOT NULL AND b.location_id=$4)
        OR ($5::bigint IS NOT NULL AND z.id=$5)
        OR ($6::bigint IS NOT NULL AND i.id=$6)
        OR ($7::bigint IS NOT NULL AND b.category_id=$7))
    ORDER BY b.arrival_at`, [capacityStatuses(), closure.ends_at, closure.starts_at,
    closure.location_id || null, closure.zone_id || null, closure.inventory_id || null, closure.category_id || null]);
  return result.rows;
}

async function lockClosureInventories(client, closure) {
  const inventory = await client.query(`SELECT DISTINCT parking_inventory.id
    FROM parking_inventory JOIN parking_zones zone ON zone.id=parking_inventory.zone_id
    WHERE ($1::bigint IS NOT NULL AND zone.location_id=$1)
      OR ($2::bigint IS NOT NULL AND zone.id=$2)
      OR ($3::bigint IS NOT NULL AND parking_inventory.id=$3)
      OR ($4::bigint IS NOT NULL AND parking_inventory.category_id=$4)
    ORDER BY parking_inventory.id`, [closure.location_id || null, closure.zone_id || null,
    closure.inventory_id || null, closure.category_id || null]);
  await lockInventoryIds(client, inventory.rows.map(row => row.id));
}

function validateClosure(candidate) {
  const scopes = ['location_id', 'zone_id', 'inventory_id', 'category_id'].filter(key => candidate[key] !== null && candidate[key] !== undefined && candidate[key] !== '');
  if (scopes.length !== 1) throw apiError('VALIDATION_ERROR', 'Choose exactly one closure scope');
  if (!['FULL_CLOSURE', 'CAPACITY_REDUCTION'].includes(String(candidate.closure_type || ''))) {
    throw apiError('VALIDATION_ERROR', 'Choose a valid closure type');
  }
  const starts = validTime(candidate.starts_at, 'Closure start');
  const ends = validTime(candidate.ends_at, 'Closure end');
  if (!starts || !ends || new Date(ends) <= new Date(starts)) throw apiError('VALIDATION_ERROR', 'Closure end must be after its start');
  if (candidate.closure_type === 'CAPACITY_REDUCTION' && wholeNumber(candidate.capacity_reduction, 'Capacity reduction', { min: 1 }) < 1) {
    throw apiError('VALIDATION_ERROR', 'Capacity reduction must be a positive whole number');
  }
}

function validateRate(candidate) {
  const rates = ['daily_rate_cents', 'weekly_rate_cents', 'monthly_rate_cents'];
  if (rates.every(key => candidate[key] === null || candidate[key] === undefined || candidate[key] === '')) {
    throw apiError('VALIDATION_ERROR', 'Configure at least one daily, weekly, or monthly rate');
  }
  rates.forEach(key => {
    if (candidate[key] !== null && candidate[key] !== undefined && candidate[key] !== '') wholeNumber(candidate[key], key.replaceAll('_', ' '));
  });
  if (candidate.fee_cents !== null && candidate.fee_cents !== undefined && candidate.fee_cents !== '') wholeNumber(candidate.fee_cents, 'Fee');
  if (candidate.tax_basis_points !== null && candidate.tax_basis_points !== undefined && candidate.tax_basis_points !== '') {
    const taxBasisPoints = wholeNumber(candidate.tax_basis_points, 'Tax basis points');
    if (taxBasisPoints > 10000) throw apiError('VALIDATION_ERROR', 'Tax rate cannot exceed 100%');
  }
  if (candidate.priority !== null && candidate.priority !== undefined && candidate.priority !== '') wholeNumber(candidate.priority, 'Priority', { min: -2147483648 });
  if (candidate.active !== undefined && typeof candidate.active !== 'boolean') throw apiError('VALIDATION_ERROR', 'Rate active status must be true or false');
  const starts = validTime(candidate.starts_at, 'Effective start');
  const ends = validTime(candidate.ends_at, 'Effective end');
  if (starts && ends && new Date(ends) <= new Date(starts)) throw apiError('VALIDATION_ERROR', 'Effective end must be after its start');
}

function rateScope(candidate) {
  return {
    locationId: wholeNumber(candidate.location_id, 'Location', { min: 1 }),
    categoryId: wholeNumber(candidate.category_id, 'Parking type', { min: 1 }),
    zoneId: candidate.zone_id === null || candidate.zone_id === undefined || candidate.zone_id === ''
      ? null
      : wholeNumber(candidate.zone_id, 'Rate zone', { min: 1 })
  };
}

async function lockRateScope(client, candidate) {
  const scope = rateScope(candidate);
  // The transaction-scoped lock makes the overlap check and write atomic while
  // preserving the existing rate schema and its legacy zone compatibility.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(
    $1::text || ':' || $2::text || ':' || COALESCE($3::text, 'all-zones'), 0))`,
  [scope.locationId, scope.categoryId, scope.zoneId]);
  return scope;
}

async function rejectAmbiguousActiveRate(client, candidate, { exceptId = null } = {}) {
  if (candidate.active === false) return;
  const scope = await lockRateScope(client, candidate);
  const existing = await client.query(`SELECT id FROM parking_rate_rules
    WHERE active
      AND location_id=$1
      AND category_id=$2
      AND zone_id IS NOT DISTINCT FROM $3::bigint
      AND COALESCE(starts_at, '-infinity'::timestamptz) < COALESCE($4::timestamptz, 'infinity'::timestamptz)
      AND COALESCE($5::timestamptz, '-infinity'::timestamptz) < COALESCE(ends_at, 'infinity'::timestamptz)
      AND ($6::bigint IS NULL OR id <> $6::bigint)
    LIMIT 1`, [scope.locationId, scope.categoryId, scope.zoneId, candidate.ends_at || null, candidate.starts_at || null, exceptId]);
  if (existing.rowCount) {
    throw apiError('RATE_RULE_OVERLAP', 'An active rate for this parking type already overlaps that effective period. Edit the existing rate or use a non-overlapping period.', 409);
  }
}

async function guardZoneReassignment(client, id, nextLocationId) {
  const dependencies = await client.query(`SELECT EXISTS(
      SELECT 1 FROM parking_inventory i JOIN parking_bookings b ON b.inventory_id=i.id WHERE i.zone_id=$1
      UNION ALL SELECT 1 FROM parking_rate_rules WHERE zone_id=$1
      UNION ALL SELECT 1 FROM parking_closures WHERE zone_id=$1
    ) in_use`, [id]);
  if (dependencies.rows[0].in_use) throw apiError('CONFIGURATION_IN_USE', 'A zone with booking, rate, or closure history cannot be moved to another location', 409);
  return nextLocationId;
}

function layoutPercentage(value, label, { positive = false } = {}) {
  if (value === undefined || value === null || value === '' || !Number.isFinite(Number(value))) {
    throw apiError('VALIDATION_ERROR', `${label} must be a number`);
  }
  const number = Number(value);
  if (number < (positive ? 0.0001 : 0) || number > 100) {
    throw apiError('VALIDATION_ERROR', `${label} must be ${positive ? 'greater than 0 and ' : ''}no more than 100`);
  }
  return number;
}

function layoutRotation(value) {
  if (value === undefined || value === null || value === '') return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < -360 || number > 360) throw apiError('VALIDATION_ERROR', 'Rotation must be between -360 and 360');
  return number;
}

function layoutBoolean(value, label) {
  if (typeof value !== 'boolean') throw apiError('VALIDATION_ERROR', `${label} must be true or false`);
  return value;
}

function layoutReference(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return wholeNumber(value, label, { min: 1 });
}

function layoutElementType(value) {
  const type = String(value || '').trim().toUpperCase();
  // Named uppercase tokens support the documented element types and safe future types
  // without accepting executable markup, CSS, or arbitrary property names.
  if (!/^[A-Z][A-Z0-9_]{1,62}$/.test(type)) throw apiError('VALIDATION_ERROR', 'Element type must be an uppercase layout token');
  return type;
}

function layoutLabel(value) {
  const label = cleanText(value, 240, 'Layout label') || '';
  if (/[<>]/.test(label)) throw apiError('VALIDATION_ERROR', 'Layout label cannot contain markup');
  return label;
}

function layoutElementInput(body, partial = false) {
  const input = {};
  const has = key => Object.hasOwn(body, key);
  if (!partial || has('element_type')) input.element_type = layoutElementType(body.element_type);
  if (!partial || has('label')) input.label = layoutLabel(body.label);
  if (!partial || has('zone_id')) input.zone_id = layoutReference(body.zone_id, 'Zone');
  if (!partial || has('inventory_id')) input.inventory_id = layoutReference(body.inventory_id, 'Inventory');
  if (!partial || has('x')) input.x = layoutPercentage(body.x, 'X position');
  if (!partial || has('y')) input.y = layoutPercentage(body.y, 'Y position');
  if (!partial || has('width')) input.width = layoutPercentage(body.width, 'Width', { positive: true });
  if (!partial || has('height')) input.height = layoutPercentage(body.height, 'Height', { positive: true });
  if (!partial || has('rotation')) input.rotation = layoutRotation(body.rotation);
  if (!partial || has('layer_order')) input.layer_order = body.layer_order === undefined ? 0 : wholeNumber(body.layer_order, 'Layer order');
  if (!partial || has('public_visible')) input.public_visible = body.public_visible === undefined ? true : layoutBoolean(body.public_visible, 'Public visibility');
  if (!partial || has('active')) input.active = body.active === undefined ? true : layoutBoolean(body.active, 'Active');
  return input;
}

async function validateLayoutElement(client, locationId, candidate) {
  if (Number(candidate.x) + Number(candidate.width) > 100 || Number(candidate.y) + Number(candidate.height) > 100) {
    throw apiError('VALIDATION_ERROR', 'Element bounds must remain within the 100 by 100 layout');
  }
  if (candidate.zone_id !== null && candidate.zone_id !== undefined) {
    const zone = await client.query('SELECT 1 FROM parking_zones WHERE id=$1 AND location_id=$2', [candidate.zone_id, locationId]);
    if (!zone.rowCount) throw apiError('VALIDATION_ERROR', 'Linked zone must belong to the layout location');
  }
  if (candidate.inventory_id !== null && candidate.inventory_id !== undefined) {
    const inventory = await client.query(`SELECT 1 FROM parking_inventory i JOIN parking_zones z ON z.id=i.zone_id
      WHERE i.id=$1 AND z.location_id=$2`, [candidate.inventory_id, locationId]);
    if (!inventory.rowCount) throw apiError('VALIDATION_ERROR', 'Linked inventory must belong to the layout location');
  }
}

async function draftLayout(client, layoutId) {
  const result = await client.query('SELECT * FROM parking_lot_layouts WHERE id=$1 FOR UPDATE', [layoutId]);
  if (!result.rowCount) throw apiError('NOT_FOUND', 'Layout not found', 404);
  if (result.rows[0].status !== 'DRAFT') throw apiError('VALIDATION_ERROR', 'Published layouts are snapshots; edit the location draft instead');
  return result.rows[0];
}

function requireLayoutVersion(layout, supplied) {
  const current = version({ version: supplied });
  if (Number(layout.version) !== current) throw apiError('LAYOUT_VERSION_CONFLICT', 'Layout changed; refresh and try again', 409);
  return current;
}

async function layoutWithElements(client, layoutId) {
  const layout = await client.query('SELECT * FROM parking_lot_layouts WHERE id=$1', [layoutId]);
  if (!layout.rowCount) return null;
  const elements = await client.query(`SELECT e.*,s.physical_section spot_physical_section,s.parking_use spot_parking_use,
    s.public_bookable spot_public_bookable,s.classification_state spot_classification_state,s.operational_label spot_operational_label,s.version parking_spot_version,
    c.code spot_category_code,c.name spot_category_name,
    rate_plan.plan_name rate_plan_name,rate_plan.active rate_plan_active,rate_plan.starts_at rate_plan_starts_at,rate_plan.ends_at rate_plan_ends_at,
    rate_plan.location_id rate_plan_location_id,rate_plan.zone_id rate_plan_zone_id,rate_plan.category_id rate_plan_category_id,
    rate_plan.daily_rate_cents rate_plan_daily_rate_cents,rate_plan.weekly_rate_cents rate_plan_weekly_rate_cents,
    rate_plan.monthly_rate_cents rate_plan_monthly_rate_cents,rate_plan.fee_cents rate_plan_fee_cents,rate_plan.tax_basis_points rate_plan_tax_basis_points,
    CASE WHEN e.parking_spot_id IS NULL THEN NULL
      WHEN NOT s.active OR NOT e.active THEN 'INACTIVE'
      WHEN EXISTS(SELECT 1 FROM parking_spot_blocks b WHERE b.parking_spot_id=s.id AND b.released_at IS NULL AND b.starts_at<=now() AND COALESCE(b.ends_at,'infinity'::timestamptz)>now()) THEN 'BLOCKED'
      WHEN EXISTS(SELECT 1 FROM reservation_spot_assignments a JOIN parking_bookings b ON b.id=a.booking_id WHERE a.parking_spot_id=s.id AND a.released_at IS NULL AND b.status='CHECKED_IN') THEN 'OCCUPIED'
      WHEN EXISTS(SELECT 1 FROM reservation_spot_assignments a JOIN parking_bookings b ON b.id=a.booking_id WHERE a.parking_spot_id=s.id AND a.released_at IS NULL AND b.status='CONFIRMED') THEN 'RESERVED'
      ELSE 'AVAILABLE' END spot_operational_status
    FROM parking_layout_elements e
    LEFT JOIN parking_spots s ON s.id=e.parking_spot_id
    LEFT JOIN parking_inventory i ON i.id=s.inventory_id
    LEFT JOIN parking_categories c ON c.id=i.category_id
    LEFT JOIN parking_rate_rules rate_plan ON rate_plan.id=e.rate_plan_id
    WHERE e.layout_id=$1 ORDER BY e.layer_order,e.id`, [layoutId]);
  const now = Date.now();
  const configured = elements.rows.map(element => {
    if (!element.parking_spot_id) return element;
    const warnings = [];
    const customer = element.parking_purpose === 'CUSTOMER';
    const anyProduct = element.daily_eligible || element.weekly_eligible || element.monthly_eligible;
    const effectivePlan = element.rate_plan_id && element.rate_plan_active
      && (!element.rate_plan_starts_at || new Date(element.rate_plan_starts_at).getTime() <= now)
      && (!element.rate_plan_ends_at || new Date(element.rate_plan_ends_at).getTime() > now);
    if (!customer && (anyProduct || element.space_public_bookable || element.rate_plan_id)) {
      warnings.push({ code: 'NON_CUSTOMER_BOOKING_CONFIGURATION', message: 'Shop, Company, Internal, and unresolved spaces cannot have customer booking products or a customer rate plan.' });
    }
    if (customer && anyProduct && !element.rate_plan_id) warnings.push({ code: 'RATE_PLAN_REQUIRED', message: 'Choose a rate plan before enabling customer parking.' });
    if (customer && element.rate_plan_id && !effectivePlan) warnings.push({ code: 'RATE_PLAN_INACTIVE', message: 'The assigned rate plan is inactive or outside its effective dates.' });
    if (customer && element.daily_eligible && element.rate_plan_daily_rate_cents == null) warnings.push({ code: 'DAILY_RATE_REQUIRED', message: 'Daily parking is enabled but the assigned plan has no daily price.' });
    if (customer && element.weekly_eligible && element.rate_plan_weekly_rate_cents == null) warnings.push({ code: 'WEEKLY_RATE_REQUIRED', message: 'Weekly parking is enabled but the assigned plan has no weekly price.' });
    if (customer && element.monthly_eligible && element.rate_plan_monthly_rate_cents == null) warnings.push({ code: 'MONTHLY_RATE_REQUIRED', message: 'Monthly parking is enabled but the assigned plan has no monthly price.' });
    return { ...element, booking_eligibility_warnings: warnings };
  });
  return { ...layout.rows[0], elements: configured };
}

async function ratePlansForLocation(client, locationId, layoutId) {
  const plans = await client.query(`SELECT rate_plan.*,category.code category_code,category.name category_name,
      count(element.id)::int assigned_space_count
    FROM parking_rate_rules rate_plan
    JOIN parking_categories category ON category.id=rate_plan.category_id
    LEFT JOIN parking_layout_elements element ON element.rate_plan_id=rate_plan.id AND element.layout_id=$2
    WHERE rate_plan.location_id=$1
    GROUP BY rate_plan.id,category.code,category.name
    ORDER BY rate_plan.active DESC,rate_plan.plan_name,rate_plan.id`, [locationId, layoutId || null]);
  return plans.rows;
}

async function locationLayoutResponse(client, locationId) {
  const layouts = await client.query(`SELECT * FROM parking_lot_layouts
    WHERE location_id=$1 ORDER BY CASE status WHEN 'DRAFT' THEN 0 ELSE 1 END`, [locationId]);
  const response = { draft: null, published: null };
  for (const layout of layouts.rows) response[layout.status.toLowerCase()] = await layoutWithElements(client, layout.id);
  response.ratePlans = await ratePlansForLocation(client, locationId, response.draft?.id || response.published?.id);
  return response;
}

function parkingLabel(value) {
  const label = cleanText(value, 80, 'Space label', true);
  if (/[<>]/.test(label)) throw apiError('VALIDATION_ERROR', 'Space label cannot contain markup');
  return label;
}

function parkingNumber(value) {
  const label = String(value ?? '').trim();
  if (!/^[1-9][0-9]{0,3}$/.test(label)) throw apiError('INVALID_SPACE_NUMBER', 'Space number must be a whole number from 1 to 9999');
  return label;
}

function bookingTerm(value) {
  const term = String(value || '').trim().toUpperCase();
  if (!['DAILY','MONTHLY'].includes(term)) throw apiError('INVALID_BOOKING_TERM', 'Choose Daily or Monthly parking');
  return term;
}

function accessType(value) {
  const access = String(value || '').trim().toUpperCase();
  if (!['CUSTOMER','SHOP','COMPANY','INTERNAL'].includes(access)) throw apiError('INVALID_SPACE_ACCESS', 'Choose Customer, Shop, Company, or Internal access');
  return access;
}

function vehicleType(value) {
  const type = String(value || '').trim().toUpperCase();
  if (!['GENERAL','BOBTAIL'].includes(type)) throw apiError('INVALID_VEHICLE_TYPE', 'Choose General Truck or Bobtail');
  return type;
}

function expectedBookingTerm(label) {
  const number = Number(parkingNumber(label));
  return number >= 110 && number <= 148 ? 'DAILY' : 'MONTHLY';
}

function elementBookingTerm(element) {
  if (element.daily_eligible && !element.monthly_eligible) return 'DAILY';
  if (element.monthly_eligible && !element.daily_eligible) return 'MONTHLY';
  return null;
}

async function editableDraft(client, locationId, actorId) {
  let draft = (await client.query("SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='DRAFT' FOR UPDATE", [locationId])).rows[0];
  if (draft) return draft;
  const published = (await client.query("SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED' FOR SHARE", [locationId])).rows[0];
  if (!published) throw apiError('PUBLISHED_LAYOUT_REQUIRED', 'Publish the parking map before editing space settings', 409);
  draft = (await client.query(`INSERT INTO parking_lot_layouts(location_id,name,status,created_by_admin_user_id,updated_by_admin_user_id)
    VALUES($1,$2,'DRAFT',$3,$3) RETURNING *`, [locationId, published.name, actorId])).rows[0];
  await client.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,
      x,y,width,height,rotation,layer_order,public_visible,active,parking_purpose,daily_eligible,weekly_eligible,
      monthly_eligible,space_public_bookable,space_internal_note,rate_plan_id)
    SELECT $1,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,
      public_visible,active,parking_purpose,daily_eligible,weekly_eligible,monthly_eligible,space_public_bookable,
      space_internal_note,rate_plan_id
    FROM parking_layout_elements WHERE layout_id=$2`, [draft.id, published.id]);
  return draft;
}

async function draftSpaceContext(client, spotId, actorId) {
  const spot = (await client.query('SELECT * FROM parking_spots WHERE id=$1 FOR UPDATE', [spotId])).rows[0];
  if (!spot) throw apiError('NOT_FOUND', 'Parking space not found', 404);
  const draft = await editableDraft(client, spot.location_id, actorId);
  const element = (await client.query(`SELECT element.*,category.code category_code
    FROM parking_layout_elements element
    JOIN parking_inventory inventory ON inventory.id=element.inventory_id
    JOIN parking_categories category ON category.id=inventory.category_id
    WHERE element.layout_id=$1 AND element.parking_spot_id=$2 FOR UPDATE OF element`, [draft.id, spotId])).rows[0];
  if (!element) throw apiError('SPACE_MISSING_FROM_DRAFT', `Space ${spot.public_label} is missing from the editable map`, 409);
  return { spot, draft, element };
}

async function compatibleInventory(client, locationId, type) {
  const code = type === 'BOBTAIL' ? 'BOBTAIL' : 'TRACTOR_TRAILER';
  const result = await client.query(`SELECT inventory.id,inventory.zone_id,inventory.category_id,category.code
    FROM parking_inventory inventory
    JOIN parking_zones zone ON zone.id=inventory.zone_id
    JOIN parking_categories category ON category.id=inventory.category_id
    WHERE zone.location_id=$1 AND inventory.active AND zone.active AND category.active AND category.code=$2
    ORDER BY zone.public_visible DESC,(zone.name='General Area') DESC,inventory.id LIMIT 1`, [locationId, code]);
  if (!result.rowCount) throw apiError('VEHICLE_TYPE_NOT_CONFIGURED', `${type === 'BOBTAIL' ? 'Bobtail' : 'General Truck'} parking is not configured for this lot`, 409);
  return result.rows[0];
}

async function compatibleRatePlan(client, locationId, inventory) {
  return (await client.query(`SELECT plan.* FROM parking_rate_rules plan
    WHERE plan.location_id=$1 AND plan.category_id=$2 AND plan.active
      AND (plan.zone_id IS NULL OR plan.zone_id=$3)
      AND (plan.starts_at IS NULL OR plan.starts_at<=now()) AND (plan.ends_at IS NULL OR plan.ends_at>now())
    ORDER BY (plan.zone_id IS NOT NULL) DESC,plan.priority DESC,plan.id DESC LIMIT 1`,
  [locationId, inventory.category_id, inventory.zone_id])).rows[0] || null;
}

async function reservationConflictsForDraftChange(client, context, candidate) {
  const assignments = await client.query(`SELECT booking.id,booking.reservation_number,booking.status,booking.parking_product,
      booking.arrival_at,booking.departure_at,booking.inventory_id
    FROM reservation_spot_assignments assignment
    JOIN parking_bookings booking ON booking.id=assignment.booking_id
    WHERE assignment.parking_spot_id=$1 AND assignment.released_at IS NULL
      AND assignment.protected_until_at>now() AND booking.status=ANY($2::text[])
    ORDER BY booking.arrival_at,booking.id`, [context.spot.id, capacityStatuses()]);
  return assignments.rows.filter(booking => candidate.access !== 'CUSTOMER' || !candidate.active
    || candidate.term !== 'MONTHLY' || Number(booking.inventory_id) !== Number(candidate.inventory.id))
    .map(booking => ({ reservationId: Number(booking.id), reservationNumber: booking.reservation_number,
      status: booking.status, parkingProduct: booking.parking_product, startsAt: booking.arrival_at, endsAt: booking.departure_at }));
}

async function applyDraftSpaceChange(req, client, spotId, body) {
  const context = await draftSpaceContext(client, spotId, req.admin.id);
  const { spot, draft, element } = context;
  if (body.layoutVersion !== undefined && Number(body.layoutVersion) !== Number(draft.version)) {
    throw apiError('LAYOUT_VERSION_CONFLICT', 'The pending parking-lot changes were updated by someone else. Refresh before saving.', 409);
  }
  if (body.elementVersion !== undefined && Number(body.elementVersion) !== Number(element.version)) {
    throw apiError('LAYOUT_ELEMENT_VERSION_CONFLICT', `Space ${element.label} changed. Refresh before saving.`, 409);
  }
  const label = body.spaceNumber === undefined ? parkingNumber(element.label) : parkingNumber(body.spaceNumber);
  const access = body.access === undefined ? accessType(element.parking_purpose === 'UNRESOLVED' ? 'INTERNAL' : element.parking_purpose) : accessType(body.access);
  const type = body.vehicleType === undefined ? (element.category_code === 'BOBTAIL' ? 'BOBTAIL' : 'GENERAL') : vehicleType(body.vehicleType);
  const active = body.controlState === undefined ? Boolean(element.active) : String(body.controlState).toUpperCase() === 'ACTIVE';
  if (body.controlState !== undefined && !['ACTIVE','INACTIVE'].includes(String(body.controlState).toUpperCase())) {
    throw apiError('INVALID_CONTROL_STATE', 'Choose Active or Inactive. Use Block Space for a temporary operational block.');
  }
  const expected = expectedBookingTerm(label);
  const term = access === 'CUSTOMER'
    ? (body.bookingTerm === undefined ? expected : bookingTerm(body.bookingTerm))
    : null;
  if (access === 'CUSTOMER' && term !== expected) {
    throw apiError('SPACE_TERM_NUMBER_MISMATCH', `Space ${label} must be ${expected === 'DAILY' ? 'Daily' : 'Monthly'} parking based on its number.`, 409,
      { space: label, requiredBookingTerm: expected });
  }
  const duplicate = await client.query(`SELECT label FROM parking_layout_elements
    WHERE layout_id=$1 AND parking_spot_id IS NOT NULL AND id<>$2 AND lower(trim(label))=lower($3) LIMIT 1`, [draft.id, element.id, label]);
  if (duplicate.rowCount) throw apiError('SPOT_LABEL_CONFLICT', `Space ${label} already exists in this parking lot`, 409);
  const inventory = await compatibleInventory(client, spot.location_id, type);
  const plan = access === 'CUSTOMER' ? await compatibleRatePlan(client, spot.location_id, inventory) : null;
  if (access === 'CUSTOMER' && !plan) throw apiError('RATE_PLAN_UNAVAILABLE', `${type === 'BOBTAIL' ? 'Bobtail' : 'General Truck'} parking needs an active rate plan before this change can be saved.`, 409);
  if (term === 'DAILY' && plan.daily_rate_cents == null) throw apiError('DAILY_RATE_REQUIRED', 'The selected vehicle type does not have a Daily rate.');
  if (access === 'CUSTOMER' && plan.weekly_rate_cents == null) throw apiError('WEEKLY_RATE_REQUIRED', 'The selected vehicle type does not have a Weekly rate.');
  if (term === 'MONTHLY' && plan.monthly_rate_cents == null) throw apiError('MONTHLY_RATE_REQUIRED', 'The selected vehicle type does not have a Monthly rate.');
  const candidate = { label, access, type, active, term, inventory, plan };
  const conflicts = await reservationConflictsForDraftChange(client, context, candidate);
  if (conflicts.length) {
    const first = conflicts[0];
    throw apiError('SPACE_RESERVATION_CONFLICT', `Space ${element.label} has reservation ${first.reservationNumber} beginning ${new Date(first.startsAt).toLocaleDateString('en-US')}. Reassign or resolve it before changing this space.`, 409, { conflicts });
  }
  const before = { spaceNumber: element.label, vehicleType: element.category_code === 'BOBTAIL' ? 'BOBTAIL' : 'GENERAL',
    bookingTerm: elementBookingTerm(element), access: element.parking_purpose, controlState: element.active ? 'ACTIVE' : 'INACTIVE',
    internalNotes: element.space_internal_note || '' };
  const internalNotes = body.internalNotes === undefined ? (element.space_internal_note || '') : (cleanText(body.internalNotes, 1000, 'Internal notes') || '');
  const updated = (await client.query(`UPDATE parking_layout_elements SET label=$1,zone_id=$2,inventory_id=$3,
      parking_purpose=$4,daily_eligible=$5,weekly_eligible=$6,monthly_eligible=$7,
      space_public_bookable=$8,active=$9,space_internal_note=$10,rate_plan_id=$11,version=version+1
    WHERE id=$12 RETURNING *`, [label,inventory.zone_id,inventory.id,access,term === 'DAILY',access === 'CUSTOMER',term === 'MONTHLY',
    access === 'CUSTOMER',active,internalNotes,plan?.id || null,element.id])).rows[0];
  const nextLayout = (await client.query(`UPDATE parking_lot_layouts SET version=version+1,updated_by_admin_user_id=$1
    WHERE id=$2 RETURNING *`, [req.admin.id,draft.id])).rows[0];
  const after = { spaceNumber: label, vehicleType: type, bookingTerm: term, access,
    controlState: active ? 'ACTIVE' : 'INACTIVE', internalNotes };
  await audit(req, 'UPDATE_DRAFT_SPACE', 'parking_spot', spot.id, { layoutId: Number(draft.id), before, after,
    changeReason: cleanText(body.changeReason, 300, 'Change reason') || null }, client);
  return { spotId: Number(spot.id), element: updated, layout: nextLayout, before, after };
}

async function parkingManagementValidation(client, layoutId) {
  const layout = await draftLayout(client, layoutId);
  const location = (await client.query('SELECT name FROM parking_locations WHERE id=$1', [layout.location_id])).rows[0];
  if (location?.name !== 'Trucker Heaven Parking') {
    return { ready: true, errors: [], warnings: [], sharedAccessPoint: null };
  }
  const [invalidSpaces, duplicateLabels, accessPoint, openConflicts] = await Promise.all([
    client.query(`SELECT spot.id,element.label,array_remove(ARRAY[
        CASE WHEN element.label !~ '^[1-9][0-9]{0,3}$' THEN 'INVALID_SPACE_NUMBER' END,
        CASE WHEN element.parking_purpose='CUSTOMER' AND NOT element.space_public_bookable THEN 'CUSTOMER_ACCESS_DISABLED' END,
        CASE WHEN element.parking_purpose='CUSTOMER' AND element.active AND element.label ~ '^[1-9][0-9]{0,3}$' AND
          (((CASE WHEN element.label ~ '^[1-9][0-9]{0,3}$' THEN element.label::int END) BETWEEN 110 AND 148 AND NOT element.daily_eligible)
            OR (NOT ((CASE WHEN element.label ~ '^[1-9][0-9]{0,3}$' THEN element.label::int END) BETWEEN 110 AND 148) AND NOT element.monthly_eligible))
          THEN 'BOOKING_TERM_NUMBER_MISMATCH' END,
        CASE WHEN element.parking_purpose='CUSTOMER' AND NOT element.weekly_eligible THEN 'WEEKLY_TERM_REQUIRED' END,
        CASE WHEN element.parking_purpose<>'CUSTOMER' AND
          (element.daily_eligible OR element.weekly_eligible OR element.monthly_eligible OR element.space_public_bookable)
          THEN 'INTERNAL_SPACE_PUBLICLY_BOOKABLE' END,
        CASE WHEN element.parking_purpose='CUSTOMER' AND element.rate_plan_id IS NULL THEN 'RATE_PLAN_REQUIRED' END
      ],NULL) reasons
      FROM parking_layout_elements element JOIN parking_spots spot ON spot.id=element.parking_spot_id
      WHERE element.layout_id=$1 AND (
        element.label !~ '^[1-9][0-9]{0,3}$'
        OR (element.parking_purpose='CUSTOMER' AND NOT element.space_public_bookable)
        OR (element.parking_purpose='CUSTOMER' AND element.active AND element.label ~ '^[1-9][0-9]{0,3}$' AND
          (((CASE WHEN element.label ~ '^[1-9][0-9]{0,3}$' THEN element.label::int END) BETWEEN 110 AND 148 AND NOT element.daily_eligible)
            OR (NOT ((CASE WHEN element.label ~ '^[1-9][0-9]{0,3}$' THEN element.label::int END) BETWEEN 110 AND 148) AND NOT element.monthly_eligible)))
        OR (element.parking_purpose='CUSTOMER' AND NOT element.weekly_eligible)
        OR (element.parking_purpose<>'CUSTOMER' AND
          (element.daily_eligible OR element.weekly_eligible OR element.monthly_eligible OR element.space_public_bookable))
        OR (element.parking_purpose='CUSTOMER' AND element.rate_plan_id IS NULL))
      ORDER BY element.label,spot.id LIMIT 50`, [layoutId]),
    client.query(`SELECT lower(trim(label)) label,count(*)::int count
      FROM parking_layout_elements WHERE layout_id=$1 AND parking_spot_id IS NOT NULL
      GROUP BY lower(trim(label)) HAVING count(*)>1 ORDER BY label`, [layoutId]),
    client.query(`WITH gap AS (
        SELECT max(element.y+element.height) FILTER (WHERE element.label='143') upper_edge,
          min(element.y) FILTER (WHERE element.label='142') lower_edge
        FROM parking_layout_elements element WHERE element.layout_id=$1 AND element.parking_spot_id IS NOT NULL
      ), access AS (
        SELECT element.id,element.x,element.y,element.width,element.height,element.label
        FROM parking_layout_elements element
        WHERE element.layout_id=$1 AND element.element_type IN ('ENTRANCE','EXIT') AND element.active
        ORDER BY CASE element.element_type WHEN 'ENTRANCE' THEN 0 ELSE 1 END,element.id LIMIT 1
      ) SELECT access.*,gap.upper_edge,gap.lower_edge,
        (access.id IS NOT NULL AND gap.upper_edge IS NOT NULL AND gap.lower_edge IS NOT NULL
          AND access.y>=gap.upper_edge AND access.y+access.height<=gap.lower_edge) valid
      FROM gap LEFT JOIN access ON true`, [layoutId]),
    client.query(`SELECT id,parking_spot_id,booking_id,conflict_code,details,detected_at
      FROM parking_configuration_conflicts WHERE location_id=$1 AND status='OPEN'
      ORDER BY detected_at,id`, [layout.location_id])
  ]);
  const errors = [
    ...invalidSpaces.rows.map(row => ({ code: 'SPACE_CONFIGURATION_INVALID', message: `Space ${row.label} has an invalid parking configuration.`, spaceId: Number(row.id), reasons: row.reasons })),
    ...duplicateLabels.rows.map(row => ({ code: 'DUPLICATE_SPACE_NUMBER', message: `Space number ${row.label} is used ${row.count} times.`, label: row.label })),
    ...(!accessPoint.rows[0]?.valid ? [{ code: 'SHARED_ACCESS_POINT_INVALID', message: 'Place the shared Entrance / Exit marker in the gap between spaces 143 and 142.' }] : []),
    ...openConflicts.rows.map(row => ({ code: row.conflict_code, message: 'A preserved reservation or data issue needs owner review.', conflictId: Number(row.id),
      spaceId: row.parking_spot_id ? Number(row.parking_spot_id) : null, bookingId: row.booking_id ? Number(row.booking_id) : null, details: row.details }))
  ];
  return { ready: errors.length === 0, errors, warnings: [], sharedAccessPoint: accessPoint.rows[0] || null };
}

async function parkingManagementReview(client, layoutId) {
  const draft = await draftLayout(client, layoutId);
  const published = (await client.query("SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED'", [draft.location_id])).rows[0] || null;
  const changes = published ? await client.query(`SELECT spot.id spot_id,published_element.label before_number,draft_element.label after_number,
      published_element.parking_purpose before_access,draft_element.parking_purpose after_access,
      published_category.code before_vehicle,draft_category.code after_vehicle,
      CASE WHEN published_element.daily_eligible THEN 'DAILY' WHEN published_element.monthly_eligible THEN 'MONTHLY' END before_term,
      CASE WHEN draft_element.daily_eligible THEN 'DAILY' WHEN draft_element.monthly_eligible THEN 'MONTHLY' END after_term,
      published_element.active before_active,draft_element.active after_active,
      published_element.space_internal_note before_notes,draft_element.space_internal_note after_notes
    FROM parking_layout_elements draft_element
    JOIN parking_spots spot ON spot.id=draft_element.parking_spot_id
    LEFT JOIN parking_layout_elements published_element ON published_element.layout_id=$2 AND published_element.parking_spot_id=spot.id
    LEFT JOIN parking_inventory published_inventory ON published_inventory.id=published_element.inventory_id
    LEFT JOIN parking_categories published_category ON published_category.id=published_inventory.category_id
    LEFT JOIN parking_inventory draft_inventory ON draft_inventory.id=draft_element.inventory_id
    LEFT JOIN parking_categories draft_category ON draft_category.id=draft_inventory.category_id
    WHERE draft_element.layout_id=$1 AND (
      published_element.id IS NULL OR published_element.label IS DISTINCT FROM draft_element.label
      OR published_element.parking_purpose IS DISTINCT FROM draft_element.parking_purpose
      OR published_element.inventory_id IS DISTINCT FROM draft_element.inventory_id
      OR published_element.daily_eligible IS DISTINCT FROM draft_element.daily_eligible
      OR published_element.monthly_eligible IS DISTINCT FROM draft_element.monthly_eligible
      OR published_element.active IS DISTINCT FROM draft_element.active
      OR published_element.space_internal_note IS DISTINCT FROM draft_element.space_internal_note)
    ORDER BY draft_element.label,spot.id`, [layoutId,published.id]) : { rows: [] };
  const capacity = async id => (await client.query(`SELECT
      count(*) FILTER (WHERE element.active AND element.parking_purpose='CUSTOMER' AND element.daily_eligible)::int daily,
      count(*) FILTER (WHERE element.active AND element.parking_purpose='CUSTOMER' AND element.monthly_eligible)::int monthly,
      count(*) FILTER (WHERE element.active AND element.parking_purpose='CUSTOMER')::int customer
    FROM parking_layout_elements element WHERE element.layout_id=$1`, [id])).rows[0];
  const [beforeCapacity,afterCapacity,validation] = await Promise.all([
    published ? capacity(published.id) : Promise.resolve({ daily: 0, monthly: 0, customer: 0 }),capacity(layoutId),parkingManagementValidation(client,layoutId)
  ]);
  return { layout: { id: Number(draft.id), version: Number(draft.version), name: draft.name },
    published: published ? { id: Number(published.id), version: Number(published.version), publishedAt: published.published_at } : null,
    changes: changes.rows.map(row => ({ spaceId: Number(row.spot_id), before: { number: row.before_number, access: row.before_access,
      vehicleType: row.before_vehicle === 'BOBTAIL' ? 'BOBTAIL' : 'GENERAL', bookingTerm: row.before_term, active: row.before_active, notes: row.before_notes },
      after: { number: row.after_number, access: row.after_access, vehicleType: row.after_vehicle === 'BOBTAIL' ? 'BOBTAIL' : 'GENERAL',
        bookingTerm: row.after_term, active: row.after_active, notes: row.after_notes } })),
    summary: { spacesChanged: changes.rowCount, dailyCapacity: { before: Number(beforeCapacity.daily), after: Number(afterCapacity.daily) },
      monthlyCapacity: { before: Number(beforeCapacity.monthly), after: Number(afterCapacity.monthly) },
      customerSpaces: { before: Number(beforeCapacity.customer), after: Number(afterCapacity.customer) },
      renumbered: changes.rows.filter(row => row.before_number !== row.after_number).length,
      vehicleTypeChanges: changes.rows.filter(row => row.before_vehicle !== row.after_vehicle).length,
      bookingTermChanges: changes.rows.filter(row => row.before_term !== row.after_term).length,
      accessChanges: changes.rows.filter(row => row.before_access !== row.after_access).length,
      activationChanges: changes.rows.filter(row => row.before_active !== row.after_active).length },
    validation };
}

function elementKey() { return `le_${crypto.randomBytes(16).toString('hex')}`; }

async function invalidateExactPublication(client, locationId) {
  await client.query(`UPDATE parking_locations SET exact_mode_active=false,
    physical_layout_confirmed_at=NULL,physical_layout_confirmed_by_admin_user_id=NULL,
    version=version+1,updated_at=now() WHERE id=$1 AND assignment_mode='EXACT_SPOT'`, [locationId]);
}

async function setupResponse(client, locationId) {
  const location = await client.query('SELECT * FROM parking_locations WHERE id=$1', [locationId]);
  if (!location.rowCount) throw apiError('NOT_FOUND', 'Parking lot not found', 404);
  const [areas, inventory, layouts, directions] = await Promise.all([
    client.query(`SELECT z.*,COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id',c.id,'code',c.code,'name',c.name))
      FILTER (WHERE c.id IS NOT NULL),'[]'::jsonb) vehicle_types
      FROM parking_zones z LEFT JOIN parking_inventory i ON i.zone_id=z.id AND i.active
      LEFT JOIN parking_categories c ON c.id=i.category_id AND c.active
      WHERE z.location_id=$1 GROUP BY z.id ORDER BY z.display_order,z.id`, [locationId]),
    client.query(`SELECT i.*,c.code category_code,c.name category_name,z.name area_name
      FROM parking_inventory i JOIN parking_categories c ON c.id=i.category_id JOIN parking_zones z ON z.id=i.zone_id
      WHERE z.location_id=$1 AND z.active AND i.active AND c.active ORDER BY z.display_order,z.id,c.name`, [locationId]),
    locationLayoutResponse(client, locationId),
    client.query('SELECT * FROM parking_area_directions WHERE location_id=$1 ORDER BY zone_id', [locationId])
  ]);
  return { location: location.rows[0], areas: areas.rows, inventory: inventory.rows, layouts, directions: directions.rows };
}

router.get('/operational-locations', roles.read, async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT id,name,address,timezone,assignment_mode,exact_mode_active,self_service_enabled,active
      FROM parking_locations ORDER BY name,id`);
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

router.post('/setup/canonical-categories', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [code, name] of canonicalParkingCategories) {
      await client.query(`INSERT INTO parking_categories(code,name,active) VALUES($1,$2,true)
        ON CONFLICT(code) DO UPDATE SET active=true`, [code, name]);
    }
    const categories = await client.query(`SELECT * FROM parking_categories WHERE code = ANY($1::text[]) ORDER BY id`,
      [canonicalParkingCategories.map(([code]) => code)]);
    await audit(req, 'ENSURE_CANONICAL_CATEGORIES', 'parking_category_catalog', 'canonical', { codes: canonicalParkingCategories.map(([code]) => code) }, client);
    await client.query('COMMIT');
    res.json({ items: categories.rows });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

async function saveSetupArea(req, res, next, { update = false } = {}) {
  const client = await pool.connect();
  try {
    const locationId = wholeNumber(req.params.locationId, 'Parking lot', { min: 1 });
    const categoryIds = [...new Set((Array.isArray(req.body.categoryIds) ? req.body.categoryIds : []).map(value => wholeNumber(value, 'Vehicle type', { min: 1 })) )];
    const active = req.body.active !== false;
    const publicVisible = req.body.publicVisible !== false;
    if ((active || publicVisible) && !categoryIds.length) throw apiError('VALIDATION_ERROR', 'Select at least one supported vehicle type.');
    const name = cleanText(req.body.name, 160, 'Parking area name', true);
    const description = cleanText(req.body.description, 4000, 'Public description') || '';
    const operationalNotes = cleanText(req.body.operationalNotes, 4000, 'Internal operational notes') || '';
    const displayOrder = wholeNumber(req.body.displayOrder ?? 0, 'Display order');
    await client.query('BEGIN');
    let zone;
    if (update) {
      const zoneId = wholeNumber(req.params.zoneId, 'Parking area', { min: 1 });
      const current = await client.query('SELECT * FROM parking_zones WHERE id=$1 AND location_id=$2 FOR UPDATE', [zoneId, locationId]);
      if (!current.rowCount) throw apiError('NOT_FOUND', 'Parking area not found', 404);
      if (Number(current.rows[0].version) !== version(req.body)) throw apiError('VERSION_CONFLICT', 'Parking area changed; refresh before saving', 409);
      zone = (await client.query(`UPDATE parking_zones SET name=$1,description=$2,operational_notes=$3,display_order=$4,active=$5,public_visible=$6,version=version+1
        WHERE id=$7 RETURNING *`, [name, description, operationalNotes, displayOrder, active, publicVisible, zoneId])).rows[0];
    } else {
      zone = (await client.query(`INSERT INTO parking_zones(location_id,name,description,operational_notes,display_order,active,public_visible)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [locationId, name, description, operationalNotes, displayOrder, active, publicVisible])).rows[0];
    }
    if (categoryIds.length) {
      const categories = await client.query('SELECT id,name FROM parking_categories WHERE active AND id = ANY($1::bigint[])', [categoryIds]);
      if (categories.rowCount !== categoryIds.length) throw apiError('VALIDATION_ERROR', 'Select active supported vehicle types.');
      await client.query(`UPDATE parking_inventory SET active=false,version=version+1
        WHERE zone_id=$1 AND NOT (category_id = ANY($2::bigint[])) AND active`, [zone.id, categoryIds]);
      for (const category of categories.rows) {
        await client.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity,active)
          VALUES($1,$2,0,$3,true,true)
          ON CONFLICT(zone_id,category_id) DO UPDATE SET active=true,version=parking_inventory.version+1`,
        [zone.id, category.id, `${name} ${category.name}`]);
      }
    } else {
      await client.query('UPDATE parking_inventory SET active=false,version=version+1 WHERE zone_id=$1 AND active', [zone.id]);
    }
    await audit(req, update ? 'UPDATE_SETUP_AREA' : 'CREATE_SETUP_AREA', 'parking_zone', zone.id, { categoryIds }, client);
    await client.query('COMMIT');
    res.status(update ? 200 : 201).json(await setupResponse(pool, locationId));
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
}

router.post('/locations/:locationId/setup/areas', csrf, roles.owner, (req, res, next) => saveSetupArea(req, res, next));
router.patch('/locations/:locationId/setup/areas/:zoneId', csrf, roles.owner, (req, res, next) => saveSetupArea(req, res, next, { update: true }));

router.get('/locations/:locationId/setup', roles.read, async (req, res, next) => {
  try { res.json(await setupResponse(pool, wholeNumber(req.params.locationId, 'Parking lot', { min: 1 }))); }
  catch (error) { next(error); }
});

router.patch('/locations/:locationId/setup', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const locationId = wholeNumber(req.params.locationId, 'Parking lot', { min: 1 });
    const currentVersion = version(req.body);
    const mapping = {
      name: 'name', publicDescription: 'public_description', address: 'address', timezone: 'timezone',
      supportPhone: 'phone', roadDirectionsUrl: 'road_directions_url', arrivalInstructions: 'arrival_instructions',
      exitInstructions: 'exit_instructions', paymentInstructions: 'payment_instructions', assignmentMode: 'assignment_mode',
      selfServiceEnabled: 'self_service_enabled', checkInEarlyMinutes: 'check_in_early_minutes',
      checkInLateMinutes: 'check_in_late_minutes', turnaroundBufferMinutes: 'turnaround_buffer_minutes',
      bookingApprovalMode: 'booking_approval_mode', cancellationCutoffHours: 'cancellation_cutoff_hours'
    };
    const submitted = Object.entries(mapping).filter(([key]) => req.body[key] !== undefined);
    if (!submitted.length) throw apiError('VALIDATION_ERROR', 'Provide lot details to update');
    await client.query('BEGIN');
    const inventory = await client.query(`SELECT inventory.id FROM parking_inventory inventory
      JOIN parking_zones zone ON zone.id=inventory.zone_id WHERE zone.location_id=$1 ORDER BY inventory.id`, [locationId]);
    await lockInventoryIds(client, inventory.rows.map(row => row.id));
    const current = await client.query('SELECT * FROM parking_locations WHERE id=$1 FOR UPDATE', [locationId]);
    if (!current.rowCount) throw apiError('NOT_FOUND', 'Parking lot not found', 404);
    if (Number(current.rows[0].version) !== currentVersion) throw apiError('VERSION_CONFLICT', 'Lot details changed; refresh before saving', 409);
    if (req.body.assignmentMode !== undefined && !['ZONE_CAPACITY', 'EXACT_SPOT'].includes(req.body.assignmentMode)) {
      throw apiError('VALIDATION_ERROR', 'Choose area-only or exact numbered-space assignment');
    }
    await rejectCanonicalExactAssignment(client, locationId, req.body.assignmentMode);
    if (req.body.roadDirectionsUrl !== undefined && req.body.roadDirectionsUrl && !/^https?:\/\//i.test(req.body.roadDirectionsUrl)) {
      throw apiError('VALIDATION_ERROR', 'Road directions must use an http or https URL');
    }
    for (const key of ['checkInEarlyMinutes', 'checkInLateMinutes', 'turnaroundBufferMinutes', 'cancellationCutoffHours']) {
      if (req.body[key] !== undefined) wholeNumber(req.body[key], key.replace(/([A-Z])/g, ' $1'));
    }
    const columns = submitted.map(([, column]) => column);
    const values = submitted.map(([key]) => req.body[key]);
    values.push(locationId, currentVersion);
    await client.query(`UPDATE parking_locations SET ${columns.map((column, index) => `${column}=$${index + 1}`).join(',')},
      exact_mode_active=CASE WHEN $${values.length - 1}::bigint=id AND assignment_mode='EXACT_SPOT' THEN false ELSE exact_mode_active END,
      physical_layout_confirmed_at=NULL,physical_layout_confirmed_by_admin_user_id=NULL,
      version=version+1,updated_at=now() WHERE id=$${values.length - 1} AND version=$${values.length}`, values);
    await audit(req, 'UPDATE_LOT_SETUP', 'parking_location', locationId, { fields: columns }, client);
    await client.query('COMMIT');
    res.json(await setupResponse(pool, locationId));
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.get('/locations/:locationId/setup-checklist', roles.read, async (req, res, next) => {
  try {
    const locationId = wholeNumber(req.params.locationId, 'Parking lot', { min: 1 });
    const layoutId = req.query.layoutId ? wholeNumber(req.query.layoutId, 'Layout', { min: 1 }) : null;
    const checklist = await setupChecklist(pool, locationId, { layoutId });
    const canonicalLayout = await hasCanonicalPhysicalLayout(pool, locationId);
    const maintenanceLocked = canonicalLayoutMaintenance.locked(canonicalLayout);
    const structuralChanges = Boolean(canonicalLayout && checklist.layout?.status === 'DRAFT'
      && await canonicalLayoutMaintenance.structuralChanges(pool, checklist.layout.id, locationId));
    const structurallyBlocked = maintenanceLocked && structuralChanges;
    const publicationCheck = {
      code: 'STRUCTURAL_MAINTENANCE_WINDOW',
      label: 'Structural publication permission',
      passed: !structurallyBlocked,
      ...(structurallyBlocked ? { message: 'This draft changes the canonical physical layout and requires an approved maintenance window before publication.' } : {})
    };
    const physicalIndex = checklist.checks.findIndex(check => check.code === 'PHYSICAL_LAYOUT_CONFIRMED');
    checklist.checks.splice(physicalIndex < 0 ? checklist.checks.length : physicalIndex, 0, publicationCheck);
    checklist.ready = checklist.checks.every(check => check.passed);
    checklist.publication = { maintenanceLocked, structuralChanges, operationalOnly: !structuralChanges };
    res.json(checklist);
  } catch (error) { next(error); }
});

router.patch('/locations/:locationId/areas/:zoneId/directions', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const locationId = wholeNumber(req.params.locationId, 'Parking lot', { min: 1 });
    const zoneId = wholeNumber(req.params.zoneId, 'Parking area', { min: 1 });
    const currentVersion = version(req.body);
    await client.query('BEGIN');
    const zone = await client.query('SELECT * FROM parking_zones WHERE id=$1 AND location_id=$2 FOR UPDATE', [zoneId, locationId]);
    if (!zone.rowCount) throw apiError('NOT_FOUND', 'Parking area not found', 404);
    if (Number(zone.rows[0].version) !== currentVersion) throw apiError('VERSION_CONFLICT', 'Parking area changed; refresh before saving', 409);
    const arrivalDirections = cleanText(req.body.arrivalDirections, 4000, 'Arrival directions') || '';
    const exitDirections = cleanText(req.body.exitDirections, 4000, 'Exit directions') || '';
    const routeKeys = value => Array.isArray(value) ? value.map(key => String(key)).filter(key => /^le_[a-f0-9]{32}$/.test(key)) : [];
    const entranceKey = req.body.entranceElementKey ? String(req.body.entranceElementKey) : null;
    const exitKey = req.body.exitElementKey ? String(req.body.exitElementKey) : null;
    await client.query(`UPDATE parking_zones SET arrival_directions=$1,exit_directions=$2,version=version+1 WHERE id=$3`,
      [arrivalDirections, exitDirections, zoneId]);
    await client.query(`INSERT INTO parking_area_directions(location_id,zone_id,entrance_element_key,exit_element_key,
        arrival_route_element_keys,exit_route_element_keys,updated_by_admin_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(zone_id) DO UPDATE SET entrance_element_key=EXCLUDED.entrance_element_key,
        exit_element_key=EXCLUDED.exit_element_key,arrival_route_element_keys=EXCLUDED.arrival_route_element_keys,
        exit_route_element_keys=EXCLUDED.exit_route_element_keys,updated_by_admin_user_id=EXCLUDED.updated_by_admin_user_id,
        version=parking_area_directions.version+1`, [locationId, zoneId, entranceKey, exitKey,
      routeKeys(req.body.arrivalRouteElementKeys), routeKeys(req.body.exitRouteElementKeys), req.admin.id]);
    await invalidateExactPublication(client, locationId);
    await audit(req, 'UPDATE_AREA_DIRECTIONS', 'parking_zone', zoneId, {}, client);
    await client.query('COMMIT');
    res.json(await setupResponse(pool, locationId));
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.get('/locations/:locationId/spots', roles.read, async (req, res, next) => {
  try {
    const locationId = wholeNumber(req.params.locationId, 'Parking lot', { min: 1 });
    const result = await pool.query(`SELECT s.*,z.name area_name,c.code category_code,c.name category_name,
        EXISTS(SELECT 1 FROM parking_spot_blocks b WHERE b.parking_spot_id=s.id AND b.released_at IS NULL
          AND b.starts_at<=now() AND COALESCE(b.ends_at,'infinity'::timestamptz)>now()) blocked
      FROM parking_spots s JOIN parking_zones z ON z.id=s.zone_id
      JOIN parking_inventory i ON i.id=s.inventory_id JOIN parking_categories c ON c.id=i.category_id
      WHERE s.location_id=$1 ORDER BY z.display_order,z.name,s.display_order,s.public_label,s.id`, [locationId]);
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

router.get('/locations/:locationId/classification-queue', roles.read, async (req, res, next) => {
  try {
    const locationId = wholeNumber(req.params.locationId, 'Parking lot', { min: 1 });
    const result = await pool.query(`SELECT s.id,s.public_label,s.physical_section,s.parking_use,s.public_bookable,s.classification_state,s.operational_label,
      c.code category_code,c.name category_name,(NOT i.active OR NOT c.active) missing_vehicle_eligibility
      FROM parking_spots s JOIN parking_inventory i ON i.id=s.inventory_id JOIN parking_categories c ON c.id=i.category_id
      WHERE s.location_id=$1 AND s.active AND (s.classification_state='NEEDS_CLASSIFICATION' OR s.parking_use='NEEDS_CLASSIFICATION'
        OR s.physical_section='UNASSIGNED' OR NOT i.active OR NOT c.active)
      ORDER BY s.physical_section,s.display_order,s.public_label`, [locationId]);
    const conflicts = result.rows.filter(item => item.public_bookable && (item.classification_state !== 'COMPLETE' || item.parking_use === 'NEEDS_CLASSIFICATION'));
    res.json({ items: result.rows, summary: { needsClassification: result.rows.filter(item => item.classification_state === 'NEEDS_CLASSIFICATION').length,
      missingVehicleEligibility: result.rows.filter(item => item.missing_vehicle_eligibility).length,
      missingSection: result.rows.filter(item => item.physical_section === 'UNASSIGNED').length,
      conflicts: conflicts.length } });
  } catch (error) { next(error); }
});

router.post(['/locations/:locationId/spots/bulk', '/locations/:locationId/spots'], csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const locationId = wholeNumber(req.params.locationId, 'Parking lot', { min: 1 });
    const zoneId = wholeNumber(req.body.zoneId, 'Parking area', { min: 1 });
    const inventoryId = wholeNumber(req.body.inventoryId, 'Vehicle type', { min: 1 });
    const single = !req.path.endsWith('/bulk');
    const quantity = single ? 1 : wholeNumber(req.body.quantity, 'Quantity', { min: 1 });
    if (quantity > 500) throw apiError('VALIDATION_ERROR', 'Generate no more than 500 spaces at once');
    const startingNumber = wholeNumber(req.body.startingNumber ?? 1, 'Starting number', { min: 0 });
    const numberPadding = wholeNumber(req.body.numberPadding ?? 2, 'Number padding', { min: 1 });
    if (numberPadding > 6) throw apiError('VALIDATION_ERROR', 'Number padding must be between 1 and 6');
    const prefix = cleanText(req.body.labelPrefix, 40, 'Label prefix') || '';
    if (/[<>]/.test(prefix)) throw apiError('VALIDATION_ERROR', 'Label prefix cannot contain markup');
    const rows = wholeNumber(req.body.rows ?? 1, 'Rows', { min: 1 });
    const perRow = wholeNumber(req.body.spacesPerRow ?? quantity, 'Spaces per row', { min: 1 });
    if (rows * perRow < quantity) throw apiError('VALIDATION_ERROR', 'Rows and spaces per row must fit the requested quantity');
    const orientation = req.body.orientation === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL';
    const reverse = req.body.rowDirection === 'REVERSE';
    const x = Number(req.body.x ?? 5), y = Number(req.body.y ?? 5);
    const width = Number(req.body.width ?? 6), height = Number(req.body.height ?? 8), spacing = Number(req.body.spacing ?? 2);
    [x, y, width, height, spacing].forEach((value, index) => {
      if (!Number.isFinite(value) || value < 0) throw apiError('VALIDATION_ERROR', `${['X','Y','Width','Height','Spacing'][index]} must be a nonnegative number`);
    });
    if (width <= 0 || height <= 0) throw apiError('VALIDATION_ERROR', 'Space width and height must be positive');
    const groupKey = cleanText(req.body.groupName, 80, 'Group name') || `group-${crypto.randomUUID()}`;
    await client.query('BEGIN');
    const inventory = await client.query(`SELECT i.id,i.zone_id,plan.id rate_plan_id,plan.daily_rate_cents,plan.weekly_rate_cents,plan.monthly_rate_cents
      FROM parking_inventory i JOIN parking_zones z ON z.id=i.zone_id
      JOIN parking_categories c ON c.id=i.category_id
      LEFT JOIN LATERAL (SELECT rule.* FROM parking_rate_rules rule
        WHERE rule.location_id=z.location_id AND rule.category_id=i.category_id AND rule.active
          AND (rule.zone_id IS NULL OR rule.zone_id=z.id)
          AND (rule.starts_at IS NULL OR rule.starts_at<=now()) AND (rule.ends_at IS NULL OR rule.ends_at>now())
        ORDER BY (rule.zone_id IS NOT NULL) DESC,rule.priority DESC,rule.id DESC LIMIT 1) plan ON true
      WHERE i.id=$1 AND i.zone_id=$2 AND z.location_id=$3 AND i.active AND z.active AND c.active`, [inventoryId, zoneId, locationId]);
    if (!inventory.rowCount) throw apiError('SPOT_NOT_ELIGIBLE', 'Choose an active vehicle type belonging to this parking area', 409);
    const layout = await client.query("SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='DRAFT' FOR UPDATE", [locationId]);
    await requireCanonicalLayoutMaintenance(client, locationId);
    if (!layout.rowCount) throw apiError('PUBLISHED_LAYOUT_REQUIRED', 'Create a draft lot layout before generating numbered spaces', 409);
    requireLayoutVersion(layout.rows[0], req.body.layoutVersion);
    const created = [];
    for (let index = 0; index < quantity; index += 1) {
      const row = Math.floor(index / perRow);
      const rawColumn = index % perRow;
      const column = reverse ? Math.min(perRow - 1, quantity - row * perRow - 1) - rawColumn : rawColumn;
      const spotX = orientation === 'HORIZONTAL' ? x + column * (width + spacing) : x + row * (width + spacing);
      const spotY = orientation === 'HORIZONTAL' ? y + row * (height + spacing) : y + column * (height + spacing);
      if (spotX + width > 100 || spotY + height > 100) throw apiError('VALIDATION_ERROR', 'Generated spaces must remain within the 100 by 100 lot map');
      const label = single && req.body.publicLabel
        ? parkingLabel(req.body.publicLabel)
        : parkingLabel(`${prefix}${String(startingNumber + index).padStart(numberPadding, '0')}`);
      const key = elementKey();
      const spot = await client.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,
          display_order,generated_group_key,visual_element_key,internal_notes,physical_section,parking_use,public_bookable,classification_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CUSTOMER',true,'COMPLETE') RETURNING *`, [locationId, zoneId, inventoryId, label,
        Number(req.body.displayOrderStart || 0) + index, groupKey, key, cleanText(req.body.internalNotes, 1000, 'Internal notes') || '', groupKey]);
      const element = await client.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,
          zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,public_visible,active,
          parking_purpose,daily_eligible,weekly_eligible,monthly_eligible,space_public_bookable,rate_plan_id)
        VALUES($1,'PARKING_SPOT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,true,
          'CUSTOMER',$13,$14,$15,true,$16) RETURNING *`,
      [layout.rows[0].id, key, label, zoneId, inventoryId, spot.rows[0].id, spotX, spotY, width, height,
        Number(req.body.rotation || 0), Number(req.body.layerOrder || 20),
        inventory.rows[0].daily_rate_cents != null, inventory.rows[0].weekly_rate_cents != null,
        inventory.rows[0].monthly_rate_cents != null, inventory.rows[0].rate_plan_id]);
      created.push({ spot: spot.rows[0], element: element.rows[0] });
    }
    const nextVersion = Number(layout.rows[0].version) + 1;
    await client.query('UPDATE parking_lot_layouts SET version=$1,updated_by_admin_user_id=$2 WHERE id=$3',
      [nextVersion, req.admin.id, layout.rows[0].id]);
    await invalidateExactPublication(client, locationId);
    await audit(req, 'BULK_CREATE_SPOTS', 'parking_location', locationId, { quantity, groupKey }, client);
    await client.query('COMMIT');
    res.status(201).json({ items: created, layoutVersion: nextVersion, groupKey });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return next(apiError('SPOT_LABEL_CONFLICT', 'One or more numbered-space labels already exist in this parking lot', 409));
    next(error);
  } finally { client.release(); }
});

router.patch('/spots/:spotId', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const spotId = wholeNumber(req.params.spotId, 'Numbered space', { min: 1 });
    const currentVersion = version(req.body);
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM parking_spots WHERE id=$1 FOR UPDATE', [spotId]);
    if (!current.rowCount) throw apiError('NOT_FOUND', 'Numbered space not found', 404);
    const spot = current.rows[0];
    if (Number(spot.version) !== currentVersion) throw apiError('VERSION_CONFLICT', 'Numbered space changed; refresh before saving', 409);
    if (req.body.publicLabel !== undefined) await requireCanonicalLayoutMaintenance(client, spot.location_id);
    if (req.body.active === false) {
      const future = await client.query(`SELECT b.reservation_number FROM reservation_spot_assignments a
        JOIN parking_bookings b ON b.id=a.booking_id WHERE a.parking_spot_id=$1 AND a.released_at IS NULL
          AND a.protected_until_at>now() AND b.status=ANY($2::text[])`, [spotId, capacityStatuses()]);
      if (future.rowCount) throw apiError('SPOT_HAS_FUTURE_ASSIGNMENTS', 'Reassign future reservations before deactivating this space', 409, { reservations: future.rows });
    }
    const mapping = { publicLabel: 'public_label', displayOrder: 'display_order', active: 'active', internalNotes: 'internal_notes', lengthFeet: 'length_feet', widthFeet: 'width_feet', physicalSection: 'physical_section', parkingUse: 'parking_use', publicBookable: 'public_bookable', classificationState: 'classification_state', operationalLabel: 'operational_label' };
    const submitted = Object.entries(mapping).filter(([key]) => req.body[key] !== undefined);
    if (!submitted.length) throw apiError('VALIDATION_ERROR', 'Provide numbered-space changes');
    const candidateUse = req.body.parkingUse === undefined ? spot.parking_use : realLotUse(req.body.parkingUse);
    const candidateState = req.body.classificationState === undefined ? spot.classification_state : realLotClassification(req.body.classificationState);
    const candidatePublic = req.body.publicBookable === undefined ? spot.public_bookable : req.body.publicBookable;
    if (typeof candidatePublic !== 'boolean') throw apiError('VALIDATION_ERROR', 'Public booking must be true or false');
    if (candidatePublic && (candidateState !== 'COMPLETE' || candidateUse === 'NEEDS_CLASSIFICATION')) throw apiError('VALIDATION_ERROR', 'Unresolved spaces cannot be publicly bookable');
    const columns = submitted.map(([, column]) => column);
    const values = submitted.map(([key]) => {
      if (key === 'publicLabel') return parkingLabel(req.body[key]);
      if (key === 'physicalSection') return realLotText(req.body[key], 'Physical section', 100);
      if (key === 'parkingUse') return candidateUse;
      if (key === 'classificationState') return candidateState;
      if (key === 'operationalLabel') return cleanText(req.body[key], 160, 'Operational label') || '';
      if (key === 'publicBookable' && typeof req.body[key] !== 'boolean') throw apiError('VALIDATION_ERROR', 'Public booking must be true or false');
      return req.body[key];
    });
    values.push(spotId, currentVersion);
    const updated = await client.query(`UPDATE parking_spots SET ${columns.map((column, index) => `${column}=$${index + 1}`).join(',')},
      version=version+1 WHERE id=$${values.length - 1} AND version=$${values.length} RETURNING *`, values);
    if (req.body.publicLabel !== undefined) await client.query('UPDATE parking_layout_elements SET label=$1 WHERE parking_spot_id=$2', [updated.rows[0].public_label, spotId]);
    await invalidateExactPublication(client, spot.location_id);
    await audit(req, 'UPDATE_SPOT', 'parking_spot', spotId, { fields: columns }, client);
    await client.query('COMMIT');
    res.json({ item: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return next(apiError('SPOT_LABEL_CONFLICT', 'That numbered-space label already exists in this parking lot', 409));
    next(error);
  } finally { client.release(); }
});

router.post('/spots/:spotId/block', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const spotId = wholeNumber(req.params.spotId, 'Numbered space', { min: 1 });
    const startsAt = req.body.startsAt ? validTime(req.body.startsAt, 'Block start') : new Date().toISOString();
    const endsAt = req.body.endsAt ? validTime(req.body.endsAt, 'Block end') : null;
    if (endsAt && new Date(endsAt) <= new Date(startsAt)) throw apiError('VALIDATION_ERROR', 'Block end must be after its start');
    const reason = cleanText(req.body.reason, 300, 'Reason', true);
    await client.query('BEGIN');
    const identity = await client.query('SELECT location_id FROM parking_spots WHERE id=$1', [spotId]);
    if (!identity.rowCount) throw apiError('NOT_FOUND', 'Numbered space not found', 404);
    const inventory = await client.query(`SELECT inventory.id FROM parking_inventory inventory
      JOIN parking_zones zone ON zone.id=inventory.zone_id WHERE zone.location_id=$1 ORDER BY inventory.id`, [identity.rows[0].location_id]);
    await lockInventoryIds(client, inventory.rows.map(row => row.id));
    const spot = await client.query('SELECT * FROM parking_spots WHERE id=$1 FOR UPDATE', [spotId]);
    if (!spot.rowCount) throw apiError('NOT_FOUND', 'Numbered space not found', 404);
    const affected = await client.query(`SELECT b.id,b.reservation_number,b.arrival_at,b.departure_at FROM reservation_spot_assignments a
      JOIN parking_bookings b ON b.id=a.booking_id WHERE a.parking_spot_id=$1 AND a.released_at IS NULL
        AND a.reserved_arrival_at<COALESCE($3::timestamptz,'infinity'::timestamptz) AND a.protected_until_at>$2
        AND b.status=ANY($4::text[]) ORDER BY b.arrival_at`, [spotId, startsAt, endsAt, capacityStatuses()]);
    if (affected.rowCount) {
      throw apiError('SPOT_BLOCK_CONFLICT', 'Reassign or resolve affected reservations before blocking this space', 409, { reservations: affected.rows });
    }
    const created = await client.query(`INSERT INTO parking_spot_blocks(parking_spot_id,starts_at,ends_at,reason,
        public_message,internal_note,created_by_admin_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [spotId, startsAt, endsAt, reason,
      cleanText(req.body.publicMessage, 500, 'Public message') || '', cleanText(req.body.internalNote, 1000, 'Internal note') || '', req.admin.id]);
    await audit(req, 'BLOCK_SPOT', 'parking_spot', spotId, { blockId: created.rows[0].id, affected: affected.rowCount }, client);
    await client.query('COMMIT');
    res.status(201).json({ item: created.rows[0], affectedReservations: affected.rows });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.post('/spots/:spotId/unblock', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const spotId = wholeNumber(req.params.spotId, 'Numbered space', { min: 1 });
    await client.query('BEGIN');
    const released = await client.query(`UPDATE parking_spot_blocks SET released_at=now(),released_by_admin_user_id=$2
      WHERE parking_spot_id=$1 AND released_at IS NULL RETURNING id`, [spotId, req.admin.id]);
    if (!released.rowCount) throw apiError('NOT_FOUND', 'No active block exists for this space', 404);
    await audit(req, 'UNBLOCK_SPOT', 'parking_spot', spotId, { blocks: released.rowCount }, client);
    await client.query('COMMIT');
    res.json({ released: released.rowCount });
  } catch (error) { await client.query('ROLLBACK'); next(error); }
  finally { client.release(); }
});

router.get('/locations/:locationId/live-lot', roles.read, async (req, res, next) => {
  try {
    const locationId = wholeNumber(req.params.locationId, 'Parking lot', { min: 1 });
    const at = req.query.at ? validTime(req.query.at, 'Operational time') : new Date().toISOString();
    const zoneId = wholeNumber(req.query.zoneId, 'Parking area', { min: 1, optional: true });
    const categoryCode = req.query.categoryCode ? String(req.query.categoryCode).trim().toUpperCase() : null;
    if (categoryCode && !/^[A-Z][A-Z0-9_]{1,62}$/.test(categoryCode)) throw apiError('VALIDATION_ERROR', 'Vehicle type is invalid');
    if (zoneId) {
      const zone = await pool.query('SELECT 1 FROM parking_zones WHERE id=$1 AND location_id=$2', [zoneId, locationId]);
      if (!zone.rowCount) throw apiError('VALIDATION_ERROR', 'Parking area does not belong to this parking lot');
    }
    res.json(await liveLot(pool, locationId, at, { zoneId, categoryCode }));
  } catch (error) { next(error); }
});

// The legacy live-lot response is retained for the existing admin screen. These
// read-only endpoints are the normalized contract for the Phase 2B map shell.
router.get('/locations/:locationId/live-lot/snapshot', roles.read, async (req, res, next) => {
  try {
    const locationId = wholeNumber(req.params.locationId, 'Parking lot', { min: 1 });
    const evaluatedAt = liveLotReadModel.iso(req.query.at, 'Operational time');
    const vehicleCategoryId = wholeNumber(req.query.vehicleCategoryId, 'Vehicle category', { min: 1, optional: true });
    res.json(await liveLotReadModel.snapshot(pool, locationId, evaluatedAt, {
      vehicleCategoryId, operationalStatus: req.query.operationalStatus, parkingUse: req.query.parkingUse,
      availableOnly: req.query.availableOnly === 'true', search: req.query.search
    }));
  } catch (error) { next(error); }
});

// The Live Lot workspace is intentionally singleton. Historical location and
// zone foreign keys stay in the database, but operators never select one.
router.get('/canonical-live-lot/snapshot', roles.read, async (req, res, next) => {
  try {
    const lot = await resolveCanonicalLot(pool);
    const evaluatedAt = liveLotReadModel.iso(req.query.at, 'Operational time');
    const vehicleCategoryId = wholeNumber(req.query.vehicleCategoryId, 'Vehicle category', { min: 1, optional: true });
    res.json(await liveLotReadModel.snapshot(pool, lot.id, evaluatedAt, {
      vehicleCategoryId, operationalStatus: req.query.operationalStatus, parkingUse: req.query.parkingUse,
      availableOnly: req.query.availableOnly === 'true', search: req.query.search
    }));
  } catch (error) { next(error); }
});

router.get('/spaces/:spotId/operational-detail', roles.read, async (req, res, next) => {
  try {
    const spotId = wholeNumber(req.params.spotId, 'Numbered space', { min: 1 });
    const evaluatedAt = liveLotReadModel.iso(req.query.at, 'Operational time');
    const detail = await liveLotReadModel.detail(pool, spotId, evaluatedAt, req.admin.role);
    const [draft, activity, conflicts] = await Promise.all([
      pool.query(`SELECT layout.id layout_id,layout.version layout_version,layout.updated_at layout_updated_at,
          element.id element_id,element.version element_version,element.label,element.parking_purpose,element.daily_eligible,
          element.monthly_eligible,element.active,element.space_internal_note,category.code category_code,
          actor.username modified_by
        FROM parking_spots spot
        LEFT JOIN parking_lot_layouts layout ON layout.location_id=spot.location_id AND layout.status='DRAFT'
        LEFT JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.parking_spot_id=spot.id
        LEFT JOIN parking_inventory inventory ON inventory.id=element.inventory_id
        LEFT JOIN parking_categories category ON category.id=inventory.category_id
        LEFT JOIN parking_admin_users actor ON actor.id=layout.updated_by_admin_user_id
        WHERE spot.id=$1`, [spotId]),
      pool.query(`SELECT event.id,event.action,event.metadata,event.created_at,actor.username
        FROM parking_audit_events event LEFT JOIN parking_admin_users actor ON actor.id=event.admin_user_id
        WHERE (event.entity_type='parking_spot' AND event.entity_id=$1)
          OR (event.metadata->>'spotId'=$1)
        ORDER BY event.created_at DESC,event.id DESC LIMIT 20`, [String(spotId)]),
      pool.query(`SELECT id,booking_id,conflict_code,details,detected_at FROM parking_configuration_conflicts
        WHERE parking_spot_id=$1 AND status='OPEN' ORDER BY detected_at,id`, [spotId])
    ]);
    const pending = draft.rows[0]?.element_id ? draft.rows[0] : null;
    res.json({ ...detail,
      draftConfiguration: pending ? { layoutId: Number(pending.layout_id), layoutVersion: Number(pending.layout_version),
        elementId: Number(pending.element_id), elementVersion: Number(pending.element_version), spaceNumber: pending.label,
        vehicleType: pending.category_code === 'BOBTAIL' ? 'BOBTAIL' : 'GENERAL',
        bookingTerm: pending.daily_eligible && !pending.monthly_eligible ? 'DAILY' : pending.monthly_eligible && !pending.daily_eligible ? 'MONTHLY' : null,
        access: pending.parking_purpose, controlState: pending.active ? 'ACTIVE' : 'INACTIVE', internalNotes: pending.space_internal_note || '',
        lastModifiedAt: pending.layout_updated_at, lastModifiedBy: pending.modified_by || null } : null,
      recentActivity: activity.rows.map(row => ({ id: Number(row.id), action: row.action, metadata: row.metadata,
        createdAt: row.created_at, user: row.username || 'System' })),
      configurationConflicts: conflicts.rows.map(row => ({ id: Number(row.id), bookingId: row.booking_id ? Number(row.booking_id) : null,
        code: row.conflict_code, details: row.details, detectedAt: row.detected_at })) });
  } catch (error) { next(error); }
});

router.patch('/spaces/:spotId/configuration', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const spotId = wholeNumber(req.params.spotId, 'Parking space', { min: 1 });
    await client.query('BEGIN');
    const result = await applyDraftSpaceChange(req, client, spotId, req.body || {});
    const review = await parkingManagementReview(client, result.layout.id);
    await client.query('COMMIT');
    res.json({ item: result, review });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

async function bulkDraftChange(req, res, next, preview) {
  const client = await pool.connect();
  try {
    const ids = Array.isArray(req.body.spaceIds) ? [...new Set(req.body.spaceIds.map(value => wholeNumber(value, 'Parking space', { min: 1 })))] : [];
    if (!ids.length || ids.length > 185) throw apiError('VALIDATION_ERROR', 'Choose between 1 and 185 parking spaces');
    const changes = req.body.changes && typeof req.body.changes === 'object' && !Array.isArray(req.body.changes) ? req.body.changes : {};
    if (!Object.keys(changes).length) throw apiError('VALIDATION_ERROR', 'Choose at least one bulk change');
    await client.query('BEGIN');
    const items = [];
    for (const id of ids.sort((a,b) => a-b)) items.push(await applyDraftSpaceChange(req, client, id, changes));
    const review = await parkingManagementReview(client, items[items.length - 1].layout.id);
    if (preview) await client.query('ROLLBACK');
    else {
      await audit(req, 'BULK_UPDATE_DRAFT_SPACES', 'parking_lot_layout', items[items.length - 1].layout.id,
        { spotIds: ids, changes: Object.keys(changes), beforeAfter: items.map(item => ({ spotId: item.spotId, before: item.before, after: item.after })) }, client);
      await client.query('COMMIT');
    }
    res.json({ preview, items: items.map(item => ({ spotId: item.spotId, before: item.before, after: item.after })), review });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* transaction may already be rolled back */ }
    next(error);
  } finally { client.release(); }
}

router.post('/spaces/bulk-preview', csrf, roles.owner, (req, res, next) => bulkDraftChange(req,res,next,true));
router.patch('/spaces/bulk-configuration', csrf, roles.owner, (req, res, next) => bulkDraftChange(req,res,next,false));

router.get('/spaces/:spotId/timeline', roles.read, async (req, res, next) => {
  try {
    const spotId = wholeNumber(req.params.spotId, 'Numbered space', { min: 1 });
    const from = liveLotReadModel.iso(req.query.from, 'Timeline start', { maxDays: liveLotReadModel.MAX_TIMELINE_DAYS });
    const defaultTo = new Date(new Date(from).getTime() + 30 * 86400000).toISOString();
    const to = req.query.to ? liveLotReadModel.iso(req.query.to, 'Timeline end', { maxDays: liveLotReadModel.MAX_TIMELINE_DAYS }) : defaultTo;
    if (new Date(to) <= new Date(from)) throw apiError('INVALID_TIMELINE_RANGE', 'Timeline end must be after start');
    if (new Date(to) - new Date(from) > liveLotReadModel.MAX_TIMELINE_DAYS * 86400000) throw apiError('TIMELINE_RANGE_TOO_LARGE', `Timeline range cannot exceed ${liveLotReadModel.MAX_TIMELINE_DAYS} days`, 422);
    res.json(await liveLotReadModel.timeline(pool, spotId, from, to));
  } catch (error) { next(error); }
});

router.get('/operational-search', roles.read, async (req, res, next) => {
  try {
    const locationId = wholeNumber(req.query.locationId, 'Parking lot', { min: 1 });
    res.json(await liveLotReadModel.search(pool, locationId, req.query.q, req.query.limit));
  } catch (error) { next(error); }
});

router.get('/canonical-live-lot/search', roles.read, async (req, res, next) => {
  try {
    const lot = await resolveCanonicalLot(pool);
    res.json(await liveLotReadModel.search(pool, lot.id, req.query.q, req.query.limit));
  } catch (error) { next(error); }
});

router.get('/locations/:locationId/layout', roles.owner, async (req, res, next) => {
  try {
    const locationId = wholeNumber(req.params.locationId, 'Location', { min: 1 });
    const location = await pool.query('SELECT id FROM parking_locations WHERE id=$1', [locationId]);
    if (!location.rowCount) throw apiError('NOT_FOUND', 'Location not found', 404);
    const response = await locationLayoutResponse(pool, locationId);
    response.canonicalMaintenanceLocked = canonicalLayoutMaintenance.locked(await hasCanonicalPhysicalLayout(pool, locationId));
    res.json(response);
  } catch (error) { next(error); }
});

router.post('/locations/:locationId/layout', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const locationId = wholeNumber(req.params.locationId, 'Location', { min: 1 });
    const name = cleanText(req.body.name, 160, 'Layout name', true);
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [locationId]);
    const location = await client.query('SELECT id FROM parking_locations WHERE id=$1', [locationId]);
    if (!location.rowCount) throw apiError('NOT_FOUND', 'Location not found', 404);
    const existing = await client.query("SELECT id FROM parking_lot_layouts WHERE location_id=$1 AND status='DRAFT'", [locationId]);
    if (existing.rowCount) throw apiError('DRAFT_LAYOUT_EXISTS', 'This location already has an editable draft layout', 409);
    const created = await client.query(`INSERT INTO parking_lot_layouts(location_id,name,status,created_by_admin_user_id,updated_by_admin_user_id)
      VALUES($1,$2,'DRAFT',$3,$3) RETURNING *`, [locationId, name, req.admin.id]);
    const published = await client.query("SELECT id FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED' FOR SHARE", [locationId]);
    if (published.rowCount) {
      await client.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,public_visible,active,parking_purpose,daily_eligible,weekly_eligible,monthly_eligible,space_public_bookable,space_internal_note,rate_plan_id)
        SELECT $1,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,public_visible,active,parking_purpose,daily_eligible,weekly_eligible,monthly_eligible,space_public_bookable,space_internal_note,rate_plan_id
        FROM parking_layout_elements WHERE layout_id=$2`, [created.rows[0].id, published.rows[0].id]);
    }
    await audit(req, 'CREATE_LAYOUT', 'parking_lot_layout', created.rows[0].id, { locationId }, client);
    await client.query('COMMIT');
    res.status(201).json({ draft: await layoutWithElements(pool, created.rows[0].id) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

async function validateDraftSpaceConfiguration(client, element, input) {
  if (!element.parking_spot_id || element.element_type !== 'PARKING_SPOT') {
    throw apiError('VALIDATION_ERROR', 'Only numbered parking spaces have configurable booking eligibility');
  }
  const spotResult = await client.query(`SELECT s.*,l.name location_name,i.category_id,i.active inventory_active,c.code category_code,c.active category_active
    FROM parking_spots s JOIN parking_locations l ON l.id=s.location_id
    LEFT JOIN parking_inventory i ON i.id=s.inventory_id LEFT JOIN parking_categories c ON c.id=i.category_id
    WHERE s.id=$1 FOR UPDATE OF s`, [element.parking_spot_id]);
  if (!spotResult.rowCount) throw apiError('NOT_FOUND', 'Numbered parking space not found', 404);
  const spot = spotResult.rows[0];
  if (input.parkingSpotVersion !== undefined && Number(spot.version) !== version({ version: input.parkingSpotVersion })) {
    throw apiError('LAYOUT_ELEMENT_VERSION_CONFLICT', 'Space changed; refresh and try again', 409);
  }
  const fallbackType = ['SHOP', 'COMPANY', 'INTERNAL', 'UNRESOLVED'].includes(element.parking_purpose)
    ? element.parking_purpose : spot.category_code === 'BOBTAIL' ? 'BOBTAIL' : 'GENERAL_TRUCK';
  const legacyPurpose = input.parkingPurpose === undefined ? null : spacePurpose(input.parkingPurpose);
  const type = input.spaceType === undefined
    ? (legacyPurpose === null || legacyPurpose === 'CUSTOMER' ? fallbackType : legacyPurpose)
    : simplifiedSpaceType(input.spaceType);
  let targetInventory = null;
  if (type === 'BOBTAIL' || type === 'GENERAL_TRUCK') {
    const categoryCode = type === 'BOBTAIL' ? 'BOBTAIL' : 'TRACTOR_TRAILER';
    const inventory = await client.query(`SELECT i.id,i.category_id,c.code FROM parking_inventory i
      JOIN parking_categories c ON c.id=i.category_id
      WHERE i.zone_id=$1 AND i.active AND c.active AND c.code=$2 ORDER BY i.id LIMIT 1`, [spot.zone_id, categoryCode]);
    if (!inventory.rowCount) throw apiError('VALIDATION_ERROR', `${type === 'BOBTAIL' ? 'Bobtail' : 'General Truck'} eligibility is not configured for this space's area`);
    targetInventory = inventory.rows[0];
  }
  const customerType = type === 'BOBTAIL' || type === 'GENERAL_TRUCK';
  const categoryChanged = Boolean(customerType && targetInventory && Number(targetInventory.id) !== Number(element.inventory_id));
  const becomingCustomer = customerType && (element.parking_purpose !== 'CUSTOMER' || categoryChanged);
  const ratePlanId = customerType
    ? (input.ratePlanId === undefined ? (becomingCustomer ? null : element.rate_plan_id) : wholeNumber(input.ratePlanId, 'Rate plan', { min: 1, optional: true }))
    : null;
  let ratePlan = null;
  if (ratePlanId !== null && ratePlanId !== undefined) {
    const found = await client.query('SELECT * FROM parking_rate_rules WHERE id=$1 FOR UPDATE', [ratePlanId]);
    if (!found.rowCount) throw apiError('VALIDATION_ERROR', 'Choose an existing rate plan');
    ratePlan = found.rows[0];
    if (Number(ratePlan.location_id) !== Number(spot.location_id) || !targetInventory || Number(ratePlan.category_id) !== Number(targetInventory.category_id)) {
      throw apiError('VALIDATION_ERROR', 'Choose a rate plan for this space type');
    }
    if (ratePlan.zone_id !== null && Number(ratePlan.zone_id) !== Number(spot.zone_id)) {
      throw apiError('VALIDATION_ERROR', 'Choose a rate plan for this space\'s parking area');
    }
  }
  const purpose = type === 'UNRESOLVED' ? 'UNRESOLVED'
    : type === 'COMPANY' ? 'COMPANY'
    : type === 'SHOP' ? 'SHOP'
    : type === 'INTERNAL' ? 'INTERNAL'
    : 'CUSTOMER';
  const active = input.active === undefined ? Boolean(element.active) : requiredBoolean(input.active, 'Active status');
  let daily = input.dailyEligible === undefined ? (becomingCustomer ? false : Boolean(element.daily_eligible)) : requiredBoolean(input.dailyEligible, 'Daily eligibility');
  let weekly = input.weeklyEligible === undefined ? (becomingCustomer ? true : Boolean(element.weekly_eligible)) : requiredBoolean(input.weeklyEligible, 'Weekly eligibility');
  let monthly = input.monthlyEligible === undefined ? (becomingCustomer ? false : Boolean(element.monthly_eligible)) : requiredBoolean(input.monthlyEligible, 'Monthly eligibility');
  let publiclyBookable = input.publiclyBookable === undefined ? (becomingCustomer ? false : Boolean(element.space_public_bookable)) : requiredBoolean(input.publiclyBookable, 'Public booking eligibility');
  if (purpose !== 'CUSTOMER') {
    daily = false;
    weekly = false;
    monthly = false;
    publiclyBookable = false;
  }
  const internalNote = input.internalNote === undefined ? element.space_internal_note : (cleanText(input.internalNote, 1000, 'Internal note') || '');
  const hasVehicleEligibility = Boolean(targetInventory || (spot.category_id && spot.inventory_active && spot.category_active));
  if (publiclyBookable && !hasVehicleEligibility) throw apiError('VALIDATION_ERROR', 'Publicly bookable spaces require complete Bobtail or General Truck eligibility');
  if (purpose === 'CUSTOMER') {
    if (!daily && !monthly) throw apiError('BOOKING_TERM_REQUIRED', 'Enable Daily or Monthly parking.');
    if (spot.location_name === 'Trucker Heaven Parking') {
      if (!weekly) throw apiError('WEEKLY_TERM_REQUIRED', 'Trucker Heaven customer spaces must offer Weekly parking.', 409);
      const requiredTerm = expectedBookingTerm(element.label);
      if ((requiredTerm === 'DAILY' && !daily) || (requiredTerm === 'MONTHLY' && !monthly)) {
        throw apiError('SPACE_TERM_NUMBER_MISMATCH', `Space ${element.label} must be ${requiredTerm === 'DAILY' ? 'Daily' : 'Monthly'} parking based on its number.`, 409);
      }
    }
    publiclyBookable = true;
  }
  const finalRatePlanId = purpose === 'CUSTOMER' ? ratePlanId || null : null;
  const eligibilityError = eligibilityErrors({
    purpose, active, publicBookable: publiclyBookable, dailyEligible: daily, weeklyEligible: weekly,
    monthlyEligible: monthly, ratePlanId: finalRatePlanId, locationId: spot.location_id,
    zoneId: spot.zone_id, categoryId: targetInventory?.category_id || spot.category_id
  }, ratePlan)[0];
  if (eligibilityError) throw apiError(eligibilityError.code, eligibilityError.message);
  return { parking_purpose: purpose, daily_eligible: daily, weekly_eligible: weekly, monthly_eligible: monthly,
    space_public_bookable: publiclyBookable, active, space_internal_note: internalNote, rate_plan_id: finalRatePlanId,
    spot, type, targetInventory };
}

router.patch('/layouts/:layoutId/spaces/:elementId', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const layoutId = wholeNumber(req.params.layoutId, 'Layout', { min: 1 });
    const elementId = wholeNumber(req.params.elementId, 'Space element', { min: 1 });
    await client.query('BEGIN');
    const layout = await draftLayout(client, layoutId);
    requireLayoutVersion(layout, req.body.layoutVersion);
    const current = await client.query('SELECT * FROM parking_layout_elements WHERE id=$1 AND layout_id=$2 FOR UPDATE', [elementId, layoutId]);
    if (!current.rowCount) throw apiError('NOT_FOUND', 'Space element not found', 404);
    if (Number(current.rows[0].version) !== version(req.body)) throw apiError('LAYOUT_ELEMENT_VERSION_CONFLICT', 'Space changed; refresh and try again', 409);
    const input = await validateDraftSpaceConfiguration(client, current.rows[0], req.body);
    const desiredInventoryId = input.targetInventory?.id || input.spot.inventory_id;
    const updated = await client.query(`UPDATE parking_layout_elements SET parking_purpose=$1,daily_eligible=$2,weekly_eligible=$3,
      monthly_eligible=$4,space_public_bookable=$5,active=$6,space_internal_note=$7,rate_plan_id=$8,inventory_id=$9,version=version+1 WHERE id=$10 RETURNING *`,
    [input.parking_purpose,input.daily_eligible,input.weekly_eligible,input.monthly_eligible,input.space_public_bookable,input.active,input.space_internal_note,input.rate_plan_id,desiredInventoryId,elementId]);
    const nextVersion = Number(layout.version) + 1;
    await client.query('UPDATE parking_lot_layouts SET version=$1,updated_by_admin_user_id=$2 WHERE id=$3', [nextVersion, req.admin.id, layoutId]);
    await audit(req, 'UPDATE_DRAFT_SPACE_CONFIGURATION', 'parking_layout_element', elementId, { layoutId, fields: Object.keys(input) }, client);
    await client.query('COMMIT');
    res.json({ item: updated.rows[0], layoutVersion: nextVersion });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.patch('/rate-plans/:id', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const ratePlanId = wholeNumber(req.params.id, 'Rate plan', { min: 1 });
    const currentVersion = version(req.body);
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM parking_rate_rules WHERE id=$1 FOR UPDATE', [ratePlanId]);
    if (!current.rowCount) throw apiError('NOT_FOUND', 'Rate plan not found', 404);
    const plan = current.rows[0];
    if (Number(plan.version) !== currentVersion) throw apiError('BOOKING_VERSION_CONFLICT', 'Rate plan changed; refresh and try again', 409);
    const value = (key, label) => req.body[key] === null ? null : wholeNumber(req.body[key], label, { min: 0, optional: true });
    const candidate = { ...plan,
      daily_rate_cents: Object.hasOwn(req.body, 'dailyRateCents') ? value('dailyRateCents', 'Daily rate') : plan.daily_rate_cents,
      weekly_rate_cents: Object.hasOwn(req.body, 'weeklyRateCents') ? value('weeklyRateCents', 'Weekly rate') : plan.weekly_rate_cents,
      monthly_rate_cents: Object.hasOwn(req.body, 'monthlyRateCents') ? value('monthlyRateCents', 'Monthly rate') : plan.monthly_rate_cents };
    validateRate(candidate);
    const updated = await client.query(`UPDATE parking_rate_rules SET daily_rate_cents=$1,weekly_rate_cents=$2,monthly_rate_cents=$3,
      version=version+1 WHERE id=$4 RETURNING *`, [candidate.daily_rate_cents, candidate.weekly_rate_cents, candidate.monthly_rate_cents, ratePlanId]);
    const assigned = await client.query('SELECT count(*)::int count FROM parking_layout_elements WHERE rate_plan_id=$1', [ratePlanId]);
    await audit(req, 'UPDATE_RATE_PLAN', 'parking_rate_rule', ratePlanId, { fields: ['daily_rate_cents', 'weekly_rate_cents', 'monthly_rate_cents'] }, client);
    await client.query('COMMIT');
    res.json({ item: { ...updated.rows[0], assigned_space_count: assigned.rows[0].count } });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.patch('/layouts/:layoutId/space-positions', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const layoutId = wholeNumber(req.params.layoutId, 'Layout', { min: 1 });
    const moves = Array.isArray(req.body.moves) ? req.body.moves : [];
    if (!moves.length || moves.length > 185) throw apiError('VALIDATION_ERROR', 'Provide one to 185 space movements');
    await client.query('BEGIN');
    const layout = await draftLayout(client, layoutId);
    await requireCanonicalLayoutMaintenance(client, layout.location_id);
    requireLayoutVersion(layout, req.body.layoutVersion);
    const seen = new Set();
    const updates = [];
    for (const move of moves) {
      const elementId = wholeNumber(move.elementId, 'Space element', { min: 1 });
      if (seen.has(elementId)) throw apiError('VALIDATION_ERROR', 'Each selected space can move only once per save');
      seen.add(elementId);
      const element = await client.query('SELECT * FROM parking_layout_elements WHERE id=$1 AND layout_id=$2 FOR UPDATE', [elementId, layoutId]);
      if (!element.rowCount || !element.rows[0].parking_spot_id || element.rows[0].element_type !== 'PARKING_SPOT') throw apiError('VALIDATION_ERROR', 'Only numbered spaces can move');
      if (Number(element.rows[0].version) !== version(move)) throw apiError('LAYOUT_ELEMENT_VERSION_CONFLICT', 'A selected space changed; refresh and try again', 409);
      const x = layoutPercentage(move.x, 'X position');
      const y = layoutPercentage(move.y, 'Y position');
      const rotation = rightAngle(move.rotation === undefined ? element.rows[0].rotation : move.rotation);
      const candidate = { ...element.rows[0], x, y, rotation };
      await validateLayoutElement(client, layout.location_id, candidate);
      const changed = await client.query('UPDATE parking_layout_elements SET x=$1,y=$2,rotation=$3,version=version+1 WHERE id=$4 RETURNING *', [x,y,rotation,elementId]);
      updates.push(changed.rows[0]);
    }
    const nextVersion = Number(layout.version) + 1;
    await client.query('UPDATE parking_lot_layouts SET version=$1,updated_by_admin_user_id=$2 WHERE id=$3', [nextVersion, req.admin.id, layoutId]);
    await invalidateExactPublication(client, layout.location_id);
    await audit(req, 'MOVE_DRAFT_SPACES', 'parking_lot_layout', layoutId, { elementIds: updates.map(item => item.id) }, client);
    await client.query('COMMIT');
    res.json({ items: updates, layoutVersion: nextVersion });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.patch('/layouts/:layoutId', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const layoutId = wholeNumber(req.params.layoutId, 'Layout', { min: 1 });
    const name = cleanText(req.body.name, 160, 'Layout name', true);
    await client.query('BEGIN');
    const layout = await draftLayout(client, layoutId);
    await requireCanonicalLayoutMaintenance(client, layout.location_id);
    requireLayoutVersion(layout, req.body.version);
    const updated = await client.query(`UPDATE parking_lot_layouts SET name=$1,version=version+1,updated_by_admin_user_id=$2
      WHERE id=$3 RETURNING *`, [name, req.admin.id, layoutId]);
    await audit(req, 'UPDATE_LAYOUT', 'parking_lot_layout', layoutId, { fields: ['name'] }, client);
    await client.query('COMMIT');
    res.json({ draft: await layoutWithElements(pool, updated.rows[0].id) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.post('/layouts/:layoutId/elements', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const layoutId = wholeNumber(req.params.layoutId, 'Layout', { min: 1 });
    const input = layoutElementInput(req.body);
    await client.query('BEGIN');
    const layout = await draftLayout(client, layoutId);
    await requireCanonicalLayoutMaintenance(client, layout.location_id);
    requireLayoutVersion(layout, req.body.layout_version);
    await validateLayoutElement(client, layout.location_id, input);
    const columns = Object.keys(input);
    const created = await client.query(`INSERT INTO parking_layout_elements(layout_id,${columns.join(',')})
      VALUES($1,${columns.map((_, index) => `$${index + 2}`).join(',')}) RETURNING *`, [layoutId, ...columns.map(key => input[key])]);
    const nextVersion = Number(layout.version) + 1;
    await client.query('UPDATE parking_lot_layouts SET version=$1,updated_by_admin_user_id=$2 WHERE id=$3', [nextVersion, req.admin.id, layoutId]);
    await invalidateExactPublication(client, layout.location_id);
    await audit(req, 'CREATE_LAYOUT_ELEMENT', 'parking_layout_element', created.rows[0].id, { layoutId, elementType: input.element_type }, client);
    await client.query('COMMIT');
    res.status(201).json({ item: created.rows[0], layoutVersion: nextVersion });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.patch('/layouts/:layoutId/elements/:elementId', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const layoutId = wholeNumber(req.params.layoutId, 'Layout', { min: 1 });
    const elementId = wholeNumber(req.params.elementId, 'Layout element', { min: 1 });
    const input = layoutElementInput(req.body, true);
    if (!Object.keys(input).length) throw apiError('VALIDATION_ERROR', 'Provide layout element fields');
    await client.query('BEGIN');
    const layout = await draftLayout(client, layoutId);
    await requireCanonicalLayoutMaintenance(client, layout.location_id);
    requireLayoutVersion(layout, req.body.layout_version);
    const current = await client.query('SELECT * FROM parking_layout_elements WHERE id=$1 AND layout_id=$2 FOR UPDATE', [elementId, layoutId]);
    if (!current.rowCount) throw apiError('NOT_FOUND', 'Layout element not found', 404);
    if (Number(current.rows[0].version) !== version(req.body)) throw apiError('LAYOUT_ELEMENT_VERSION_CONFLICT', 'Layout element changed; refresh and try again', 409);
    const candidate = { ...current.rows[0], ...input };
    await validateLayoutElement(client, layout.location_id, candidate);
    const columns = Object.keys(input);
    const updated = await client.query(`UPDATE parking_layout_elements SET ${columns.map((key, index) => `${key}=$${index + 1}`).join(',')},version=version+1
      WHERE id=$${columns.length + 1} RETURNING *`, [...columns.map(key => input[key]), elementId]);
    const nextVersion = Number(layout.version) + 1;
    await client.query('UPDATE parking_lot_layouts SET version=$1,updated_by_admin_user_id=$2 WHERE id=$3', [nextVersion, req.admin.id, layoutId]);
    await invalidateExactPublication(client, layout.location_id);
    await audit(req, 'UPDATE_LAYOUT_ELEMENT', 'parking_layout_element', elementId, { layoutId, fields: columns }, client);
    await client.query('COMMIT');
    res.json({ item: updated.rows[0], layoutVersion: nextVersion });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.delete('/layouts/:layoutId/elements/:elementId', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const layoutId = wholeNumber(req.params.layoutId, 'Layout', { min: 1 });
    const elementId = wholeNumber(req.params.elementId, 'Layout element', { min: 1 });
    await client.query('BEGIN');
    const layout = await draftLayout(client, layoutId);
    await requireCanonicalLayoutMaintenance(client, layout.location_id);
    requireLayoutVersion(layout, req.body.layout_version);
    const linked = await client.query('SELECT parking_spot_id FROM parking_layout_elements WHERE id=$1 AND layout_id=$2 FOR UPDATE', [elementId, layoutId]);
    if (linked.rows[0]?.parking_spot_id) throw apiError('LAYOUT_SPOT_LINK_REQUIRED', 'Deactivate the numbered space before removing its linked map element', 409);
    const removed = await client.query('DELETE FROM parking_layout_elements WHERE id=$1 AND layout_id=$2 RETURNING id', [elementId, layoutId]);
    if (!removed.rowCount) throw apiError('NOT_FOUND', 'Layout element not found', 404);
    const nextVersion = Number(layout.version) + 1;
    await client.query('UPDATE parking_lot_layouts SET version=$1,updated_by_admin_user_id=$2 WHERE id=$3', [nextVersion, req.admin.id, layoutId]);
    await invalidateExactPublication(client, layout.location_id);
    await audit(req, 'DELETE_LAYOUT_ELEMENT', 'parking_layout_element', elementId, { layoutId }, client);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.get('/layouts/:layoutId/review', roles.owner, async (req, res, next) => {
  try {
    const layoutId = wholeNumber(req.params.layoutId, 'Parking lot draft', { min: 1 });
    res.json(await parkingManagementReview(pool, layoutId));
  } catch (error) { next(error); }
});

router.post('/layouts/:layoutId/publish', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const layoutId = wholeNumber(req.params.layoutId, 'Layout', { min: 1 });
    await client.query('BEGIN');
    const draft = await draftLayout(client, layoutId);
    requireLayoutVersion(draft, req.body.version);
    await requireCanonicalPublicationMaintenance(client, draft.location_id, layoutId);
    const managementValidation = await parkingManagementValidation(client, layoutId);
    if (!managementValidation.ready) throw apiError('PUBLISH_VALIDATION_FAILED', 'Resolve the listed parking-lot issues before publishing.', 409,
      { issues: managementValidation.errors });
    const mapIntegrity = await client.query(`SELECT s.public_label
      FROM parking_spots s
      LEFT JOIN parking_layout_elements e ON e.layout_id=$1 AND e.parking_spot_id=s.id
      WHERE s.location_id=$2 AND (
        (s.active AND e.id IS NULL)
        OR (e.id IS NOT NULL AND (
          e.parking_purpose IS NULL
          OR (e.parking_purpose IN ('SHOP','COMPANY','UNRESOLVED')
            AND (e.daily_eligible OR e.weekly_eligible OR e.monthly_eligible OR e.space_public_bookable OR e.rate_plan_id IS NOT NULL))
          OR (NOT e.active AND (e.daily_eligible OR e.weekly_eligible OR e.monthly_eligible OR e.space_public_bookable OR e.rate_plan_id IS NOT NULL))
          OR (e.space_public_bookable AND e.parking_purpose<>'CUSTOMER')
          OR (e.parking_purpose='CUSTOMER' AND (e.daily_eligible OR e.weekly_eligible OR e.monthly_eligible) AND NOT EXISTS (
            SELECT 1 FROM parking_rate_rules plan
            JOIN parking_inventory inventory ON inventory.id=e.inventory_id
            WHERE plan.id=e.rate_plan_id AND plan.active AND plan.location_id=$2
              AND plan.category_id=inventory.category_id
              AND (plan.zone_id IS NULL OR plan.zone_id=COALESCE(e.zone_id,s.zone_id))
              AND (plan.starts_at IS NULL OR plan.starts_at<=now())
              AND (plan.ends_at IS NULL OR plan.ends_at>now())
              AND (NOT e.daily_eligible OR plan.daily_rate_cents IS NOT NULL)
              AND (NOT e.weekly_eligible OR plan.weekly_rate_cents IS NOT NULL)
              AND (NOT e.monthly_eligible OR plan.monthly_rate_cents IS NOT NULL)
          ))
        ))
      ) LIMIT 10`, [layoutId, draft.location_id]);
    if (mapIntegrity.rowCount) throw apiError('LAYOUT_SPACE_CONFIGURATION_INVALID', 'Every active space must be on the map with a valid customer-safe configuration', 409,
      { spaces: mapIntegrity.rows.map(row => row.public_label) });
    const publicElementCount = await client.query(`SELECT count(*)::int count FROM parking_layout_elements
      WHERE layout_id=$1 AND active AND public_visible`, [layoutId]);
    if (!publicElementCount.rows[0].count) throw apiError('LAYOUT_INCOMPLETE', 'Add at least one active public layout element before publishing', 409);
    // Acquire the exact-allocation inventory/space locks before the location
    // row. This both prioritizes assignment conflicts over generic setup errors
    // and keeps booking/publication transactions in one global lock order.
    await protectAssignedSpaces(client, draft);
    const location = (await client.query('SELECT * FROM parking_locations WHERE id=$1 FOR UPDATE', [draft.location_id])).rows[0];
    let exactChecklist = null;
    if (location.assignment_mode === 'EXACT_SPOT') {
      exactChecklist = await setupChecklist(client, draft.location_id, {
        layoutId,
        physicalConfirmation: req.body.physicalConfirmation === true
      });
      if (!exactChecklist.ready) {
        throw apiError('EXACT_SPOT_SETUP_INCOMPLETE', 'Complete the failed exact-space setup checks before publishing', 409, {
          checks: exactChecklist.checks.filter(check => !check.passed)
        });
      }
    }
    const publication = await publishDraftSnapshot(client, { layoutId, actorId: req.admin.id });
    const updatedDraft = await client.query(`UPDATE parking_lot_layouts SET version=version+1,updated_by_admin_user_id=$1
      WHERE id=$2 RETURNING *`, [req.admin.id, layoutId]);
    if (location.assignment_mode === 'EXACT_SPOT') {
      await client.query(`UPDATE parking_locations SET exact_mode_active=true,self_service_enabled=$2,
        physical_layout_confirmed_at=now(),physical_layout_confirmed_by_admin_user_id=$3,
        version=version+1,updated_at=now() WHERE id=$1`, [draft.location_id, location.self_service_enabled, req.admin.id]);
    }
    await audit(req, 'PUBLISH_LAYOUT', 'parking_lot_layout', layoutId, { publishedLayoutId: publication.published.id, publicElementCount: publicElementCount.rows[0].count }, client);
    await client.query('COMMIT');
    res.json({ draft: await layoutWithElements(pool, updatedDraft.rows[0].id), published: await layoutWithElements(pool, publication.published.id) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.post('/locations/:locationId/rollback-layout', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const locationId = wholeNumber(req.params.locationId, 'Parking lot', { min: 1 });
    if (req.body.confirmation !== 'RESTORE_PREVIOUS_LAYOUT') throw apiError('CONFIRMATION_REQUIRED', 'Confirm that you want to restore the previously published parking lot.');
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [locationId]);
    const current = (await client.query("SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED' FOR UPDATE", [locationId])).rows[0];
    const previous = (await client.query(`SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='SUPERSEDED'
      ORDER BY published_at DESC,id DESC LIMIT 1 FOR UPDATE`, [locationId])).rows[0];
    if (!current || !previous) throw apiError('ROLLBACK_UNAVAILABLE', 'There is no previously published parking lot to restore.', 409);
    const draft = await editableDraft(client, locationId, req.admin.id);
    const pending = await parkingManagementReview(client, draft.id);
    if (pending.summary.spacesChanged && req.body.discardPendingChanges !== true) {
      throw apiError('PENDING_CHANGES_EXIST', 'Review or discard the current pending changes before restoring the previous parking lot.', 409,
        { spacesChanged: pending.summary.spacesChanged });
    }
    await client.query('DELETE FROM parking_layout_elements WHERE layout_id=$1', [draft.id]);
    await client.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,
        x,y,width,height,rotation,layer_order,public_visible,active,parking_purpose,daily_eligible,weekly_eligible,
        monthly_eligible,space_public_bookable,space_internal_note,rate_plan_id)
      SELECT $1,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,
        public_visible,active,parking_purpose,daily_eligible,weekly_eligible,monthly_eligible,space_public_bookable,
        space_internal_note,rate_plan_id FROM parking_layout_elements WHERE layout_id=$2`, [draft.id, previous.id]);
    const updatedDraft = (await client.query(`UPDATE parking_lot_layouts SET name=$1,version=version+1,updated_by_admin_user_id=$2
      WHERE id=$3 RETURNING *`, [previous.name,req.admin.id,draft.id])).rows[0];
    const validation = await parkingManagementValidation(client, draft.id);
    if (!validation.ready) throw apiError('ROLLBACK_VALIDATION_FAILED', 'The previous parking lot cannot be safely restored with current reservations.', 409,
      { issues: validation.errors });
    const publication = await publishDraftSnapshot(client, { layoutId: draft.id, actorId: req.admin.id });
    await audit(req, 'ROLLBACK_LAYOUT', 'parking_lot_layout', draft.id, { restoredFromLayoutId: Number(previous.id),
      replacedPublishedLayoutId: Number(current.id), publishedLayoutId: Number(publication.published.id) }, client);
    await client.query('COMMIT');
    res.json({ draft: { id: Number(updatedDraft.id), version: Number(updatedDraft.version) },
      published: { id: Number(publication.published.id), version: Number(publication.published.version) }, restoredFromLayoutId: Number(previous.id) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.get('/admin-users', roles.owner, async (_req, res, next) => {
  try {
    res.json({ persistence: 'POSTGRESQL', items: (await pool.query(`SELECT id,display_name,email,username,role,active,version,last_login_at,created_at,updated_at
      FROM parking_admin_users ORDER BY COALESCE(NULLIF(display_name,''),username),username`)).rows });
  } catch (error) { next(error); }
});

router.post('/admin-users', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const role = String(req.body.role || '').toUpperCase();
    const password = String(req.body.password || '');
    const displayName = cleanText(req.body.displayName, 120, 'Name') || '';
    const adminEmail = req.body.email ? email(req.body.email) : null;
    if (!/^[a-z0-9._-]{3,80}$/.test(username) || !['OWNER', 'STAFF'].includes(role) || password.length < 16) {
      throw apiError('VALIDATION_ERROR', 'Provide a valid username, role, and a password of at least 16 characters');
    }
    await client.query('BEGIN');
    const created = await client.query(`INSERT INTO parking_admin_users(username,password_hash,role,display_name,email)
      VALUES($1,$2,$3,$4,$5) RETURNING id,display_name,email,username,role,active,version,last_login_at,created_at,updated_at`,
    [username, await bcrypt.hash(password, 12), role, displayName, adminEmail]);
    await audit(req, 'CREATE_ADMIN_USER', 'admin_user', created.rows[0].id, { role, displayName, email: adminEmail }, client);
    await client.query('COMMIT');
    res.status(201).json({ item: created.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); next(error); }
  finally { client.release(); }
});

router.patch('/admin-users/:id', csrf, roles.owner, async (req, res, next) => {
  let client;
  try {
    client = await pool.connect();
    if (String(req.params.id) === String(req.admin.id) && req.body.active === false) throw apiError('VALIDATION_ERROR', 'You cannot disable your own active session');
    const currentVersion = adminUserVersion(req.body);
    await client.query('BEGIN');
    // Acquire every active-owner lock in a stable order before locking the
    // target account. That makes concurrent demotion/deactivation requests
    // serialize without allowing the final active owner to disappear.
    const activeOwners = await client.query(`SELECT id FROM parking_admin_users
      WHERE role='OWNER' AND active ORDER BY id FOR UPDATE`);
    const current = await client.query('SELECT * FROM parking_admin_users WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!current.rowCount) throw apiError('NOT_FOUND', 'Admin user not found', 404);
    const existing = current.rows[0];
    if (Number(existing.version) !== currentVersion) {
      throw apiError('ADMIN_USER_VERSION_CONFLICT', 'This user changed; refresh and try again', 409);
    }
    const nextRole = req.body.role === undefined ? existing.role : String(req.body.role).toUpperCase();
    const nextActive = req.body.active === undefined ? existing.active : req.body.active;
    if (!['OWNER', 'STAFF'].includes(nextRole)) throw apiError('VALIDATION_ERROR', 'Invalid role');
    if (typeof nextActive !== 'boolean') throw apiError('VALIDATION_ERROR', 'Active status must be true or false');
    if (existing.role === 'OWNER' && existing.active && (nextRole !== 'OWNER' || !nextActive) && activeOwners.rowCount <= 1) {
      throw apiError('LAST_ACTIVE_OWNER_REQUIRED', 'At least one active Owner account must remain', 409);
    }
    const fields = [];
    const values = [];
    let revokeSessions = false;
    if (nextRole !== existing.role) {
      fields.push(`role=$${values.push(nextRole)}`);
      revokeSessions = true;
    }
    if (nextActive !== existing.active) {
      fields.push(`active=$${values.push(nextActive)}`);
      revokeSessions ||= !nextActive;
    }
    if (req.body.displayName !== undefined) fields.push(`display_name=$${values.push(cleanText(req.body.displayName, 120, 'Name') || '')}`);
    if (req.body.email !== undefined) fields.push(`email=$${values.push(req.body.email ? email(req.body.email) : null)}`);
    if (req.body.password !== undefined) {
      if (String(req.body.password).length < 16) throw apiError('VALIDATION_ERROR', 'Password must be at least 16 characters');
      fields.push(`password_hash=$${values.push(await bcrypt.hash(String(req.body.password), 12))}`);
      revokeSessions = true;
    }
    if (!fields.length) throw apiError('VALIDATION_ERROR', 'No changes provided');
    values.push(existing.id, currentVersion);
    const updated = await client.query(`UPDATE parking_admin_users SET ${fields.join(',')},version=version+1,updated_at=now()
      WHERE id=$${values.length - 1} AND version=$${values.length}
      RETURNING id,display_name,email,username,role,active,version,last_login_at,created_at,updated_at`, values);
    if (!updated.rowCount) throw apiError('ADMIN_USER_VERSION_CONFLICT', 'This user changed; refresh and try again', 409);
    if (revokeSessions) await client.query('DELETE FROM parking_admin_sessions WHERE admin_user_id=$1', [existing.id]);
    if (nextRole !== existing.role) await audit(req, 'CHANGE_ADMIN_USER_ROLE', 'admin_user', existing.id, { from: existing.role, to: nextRole }, client);
    if (nextActive !== existing.active) await audit(req, nextActive ? 'ACTIVATE_ADMIN_USER' : 'DEACTIVATE_ADMIN_USER', 'admin_user', existing.id, {}, client);
    if (req.body.password !== undefined) await audit(req, 'RESET_ADMIN_USER_CREDENTIALS', 'admin_user', existing.id, {}, client);
    await client.query('COMMIT');
    res.json({ item: updated.rows[0] });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    next(error);
  } finally { if (client) client.release(); }
});

router.get('/summary', roles.read, async (req, res, next) => {
  try {
    const lot = await resolveCanonicalLot(pool);
    const evaluatedAt = liveLotReadModel.iso(req.query.at, 'Operational time');
    const [liveSnapshot, payments, parkingMix, balances] = await Promise.all([
      liveLotReadModel.snapshot(pool, lot.id, evaluatedAt),
      pool.query(`WITH bounds AS (
          SELECT date_trunc('year',$1::timestamptz AT TIME ZONE $2)::date year_start,
            date_trunc('month',$1::timestamptz AT TIME ZONE $2)::date month_start
        ), effective_payment AS (
          SELECT payment.id,payment.payment_date,payment.parking_product,
            payment.amount_cents+COALESCE(sum(adjustment.amount_cents),0) amount_cents
          FROM parking_customer_payments payment
          LEFT JOIN parking_customer_payment_adjustments adjustment ON adjustment.payment_id=payment.id
          WHERE payment.status='PAID' AND payment.payment_date<=($1::timestamptz AT TIME ZONE $2)::date
          GROUP BY payment.id
        ), monthly AS (
          SELECT month::date month_start,COALESCE(sum(payment.amount_cents),0)::bigint paid_cents
          FROM bounds CROSS JOIN LATERAL generate_series(bounds.year_start,bounds.year_start+interval '11 months',interval '1 month') month
          LEFT JOIN effective_payment payment ON payment.payment_date>=month::date
            AND payment.payment_date<(month+interval '1 month')::date
          GROUP BY month
        ), by_product AS (
          SELECT CASE WHEN payment.parking_product IN ('DAILY','WEEKLY','MONTHLY') THEN payment.parking_product ELSE 'OTHER' END product,
            sum(payment.amount_cents)::bigint paid_cents
          FROM effective_payment payment,bounds
          WHERE payment.payment_date>=bounds.year_start AND payment.payment_date<(bounds.year_start+interval '1 year')::date
          GROUP BY 1
        ) SELECT to_char(bounds.year_start,'YYYY')::int report_year,bounds.month_start,
          COALESCE((SELECT sum(paid_cents) FROM monthly WHERE month_start=bounds.month_start),0)::bigint paid_this_month_cents,
          COALESCE((SELECT sum(paid_cents) FROM monthly),0)::bigint paid_ytd_cents,
          (SELECT jsonb_agg(jsonb_build_object('month',to_char(month_start,'YYYY-MM'),'paidCents',paid_cents) ORDER BY month_start) FROM monthly) payments_by_month,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('product',product,'paidCents',paid_cents) ORDER BY product) FROM by_product),'[]'::jsonb) revenue_by_product
        FROM bounds`, [evaluatedAt, lot.timezone]),
      pool.query(`SELECT parking_product,count(*)::int count
        FROM parking_bookings
        WHERE status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT') AND arrival_at<=$1
          AND (departure_at IS NULL OR departure_at>$1 OR (parking_product='MONTHLY' AND billing_period_end_at>$1
            AND subscription_status IN ('ACTIVE','TRIALING','PAST_DUE','PAYMENT_ACTION_REQUIRED')))
        GROUP BY parking_product`, [evaluatedAt]),
      pool.query(`SELECT
          COALESCE(sum(balance_cents) FILTER (WHERE status IN ('DUE','PARTIAL','OVERDUE')),0)::bigint outstanding_cents,
          COALESCE(sum(balance_cents) FILTER (WHERE status='OVERDUE'),0)::bigint overdue_cents
        FROM parking_customer_billing_period_balances`)
    ]);
    const upcoming = await pool.query(`SELECT count(*)::int count FROM parking_bookings
      WHERE status='CONFIRMED' AND payment_status IN ('PAID','NOT_REQUIRED','DEMO_BYPASSED') AND arrival_at>$1`, [evaluatedAt]);
    const productCounts = Object.fromEntries(parkingMix.rows.map(row => [row.parking_product, Number(row.count)]));
    const finance = payments.rows[0];
    res.json({
      evaluatedAt, year: Number(finance.report_year),
      parking: {
        totalCustomerSpaces: Number(liveSnapshot.summary.customerSpaces || 0),
        available: Number(liveSnapshot.summary.availableCustomerSpaces || 0),
        occupied: Number(liveSnapshot.summary.occupied || 0),
        reserved: Number(liveSnapshot.summary.reserved || 0)
      },
      parkingMix: {
        daily: productCounts.DAILY || 0, weekly: productCounts.WEEKLY || 0,
        monthly: productCounts.MONTHLY || 0, upcomingReserved: Number(upcoming.rows[0].count || 0)
      },
      payments: {
        paidThisMonthCents: Number(finance.paid_this_month_cents || 0),
        paidYtdCents: Number(finance.paid_ytd_cents || 0),
        outstandingCents: Number(balances.rows[0].outstanding_cents || 0),
        overdueCents: Number(balances.rows[0].overdue_cents || 0),
        byMonth: finance.payments_by_month || [], byProduct: finance.revenue_by_product || []
      }
    });
  } catch (error) { next(error); }
});

router.get('/dashboard', roles.read, async (req, res, next) => {
  try {
    await expirePendingNow();
    const periodStart = req.query.from ? validTime(req.query.from, 'Period start') : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const periodEnd = req.query.to ? validTime(req.query.to, 'Period end') : new Date().toISOString();
    if (new Date(periodEnd) <= new Date(periodStart)) throw apiError('VALIDATION_ERROR', 'Period end must be after period start');
    const summary = await pool.query(`SELECT
      (SELECT count(*) FROM parking_bookings b JOIN parking_locations l ON l.id=b.location_id
        WHERE (b.arrival_at AT TIME ZONE l.timezone)::date=(now() AT TIME ZONE l.timezone)::date
          AND b.status='CONFIRMED')::int arrivals,
      (SELECT count(*) FROM parking_bookings WHERE status='CHECKED_IN')::int checked_in,
      (SELECT count(*) FROM parking_bookings b JOIN parking_locations l ON l.id=b.location_id
        WHERE (b.departure_at AT TIME ZONE l.timezone)::date=(now() AT TIME ZONE l.timezone)::date
          AND b.status IN ('CONFIRMED','CHECKED_IN'))::int departures,
      (SELECT count(*) FROM parking_bookings WHERE departure_at<now() AND status='CHECKED_IN')::int overdue,
      (SELECT count(*) FROM parking_bookings WHERE status='NO_SHOW')::int no_shows,
      (SELECT count(*) FROM parking_bookings WHERE arrival_at>=now() AND status='CONFIRMED')::int upcoming,
      (SELECT count(DISTINCT b.customer_id) FROM parking_bookings b
        WHERE b.customer_id IS NOT NULL AND b.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')
          AND b.arrival_at<=now() AND (b.departure_at IS NULL OR b.departure_at>now() OR (b.parking_product='MONTHLY'
            AND b.billing_period_end_at>now()
            AND b.subscription_status IN ('ACTIVE','TRIALING','PAST_DUE','PAYMENT_ACTION_REQUIRED'))))::int current_customers,
      (SELECT count(DISTINCT customer_id) FROM parking_customer_billing_period_balances
        WHERE status='OVERDUE')::int overdue_customers,
      (SELECT COALESCE(sum(balance_cents),0) FROM parking_customer_billing_period_balances
        WHERE status='OVERDUE')::bigint overdue_balance_cents,
      (SELECT count(*) FROM parking_spots s JOIN parking_lot_layouts layout ON layout.location_id=s.location_id AND layout.status='PUBLISHED'
        JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.parking_spot_id=s.id AND element.active
        WHERE s.active)::int active_physical_spaces,
      (SELECT count(*) FROM parking_spots s JOIN parking_lot_layouts layout ON layout.location_id=s.location_id AND layout.status='PUBLISHED'
        JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.parking_spot_id=s.id AND element.active
        WHERE s.active AND element.monthly_eligible)::int monthly_spaces,
      (SELECT count(DISTINCT b.id) FROM parking_bookings b
        JOIN parking_booking_price_snapshots p ON p.booking_id=b.id
        WHERE p.snapshot->>'duration'='MONTHLY' AND b.payment_status IN ('PAID','NOT_REQUIRED','DEMO_BYPASSED') AND b.status IN ('CONFIRMED','CHECKED_IN')
          AND b.arrival_at<=now() AND (b.departure_at IS NULL OR b.departure_at>now()))::int monthly_active,
      (SELECT count(*) FROM parking_bookings WHERE payment_status IN ('PAST_DUE','PAYMENT_ACTION_REQUIRED'))::int billing_attention,
      (SELECT count(*) FROM parking_customer_documents WHERE upload_status='UPLOADED' AND verification_status='PENDING_REVIEW')::int insurance_pending_review,
      (SELECT count(*) FROM parking_spots s
        JOIN parking_lot_layouts layout ON layout.location_id=s.location_id AND layout.status='PUBLISHED'
        JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.parking_spot_id=s.id
          AND element.element_type='PARKING_SPOT' AND element.active AND element.public_visible
        WHERE s.active AND CASE WHEN element.parking_purpose IS NULL THEN s.public_bookable ELSE element.space_public_bookable END
          AND COALESCE(element.parking_purpose,CASE WHEN s.parking_use IN ('CUSTOMER','CUSTOMER_BOBTAIL','DAILY','WEEKLY','MONTHLY') THEN 'CUSTOMER' ELSE 'UNRESOLVED' END)='CUSTOMER'
          AND s.classification_state='COMPLETE')::int publicly_bookable_spaces,
      (SELECT count(*) FROM parking_spots s
        JOIN parking_inventory i ON i.id=s.inventory_id AND i.active
        JOIN parking_zones z ON z.id=i.zone_id AND z.active
        JOIN parking_locations l ON l.id=z.location_id AND l.active
          AND l.assignment_mode='EXACT_SPOT' AND l.exact_mode_active
        JOIN parking_categories c ON c.id=i.category_id AND c.active
        JOIN parking_lot_layouts layout ON layout.location_id=s.location_id AND layout.status='PUBLISHED'
        JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.parking_spot_id=s.id
          AND element.element_type='PARKING_SPOT' AND element.active AND element.public_visible
        WHERE s.active AND CASE WHEN element.parking_purpose IS NULL THEN s.public_bookable ELSE element.space_public_bookable END
        AND COALESCE(element.parking_purpose,CASE WHEN s.parking_use IN ('CUSTOMER','CUSTOMER_BOBTAIL','DAILY','WEEKLY','MONTHLY') THEN 'CUSTOMER' ELSE 'UNRESOLVED' END)='CUSTOMER'
        AND s.classification_state='COMPLETE'
        AND NOT EXISTS (SELECT 1 FROM parking_spot_blocks block WHERE block.parking_spot_id=s.id AND block.released_at IS NULL
          AND block.starts_at<=now() AND COALESCE(block.ends_at,'infinity'::timestamptz)>now())
        AND NOT EXISTS (SELECT 1 FROM reservation_spot_assignments a JOIN parking_bookings booking ON booking.id=a.booking_id
          WHERE a.parking_spot_id=s.id AND a.released_at IS NULL AND a.reserved_arrival_at<=now() AND a.protected_until_at>now()
            AND booking.status=ANY($3::text[])))::int available_spaces,
      (SELECT count(*) FROM reservation_spot_assignments a JOIN parking_bookings booking ON booking.id=a.booking_id
        WHERE a.released_at IS NULL AND a.reserved_arrival_at<=now() AND a.protected_until_at>now()
          AND booking.status='CONFIRMED')::int reserved_spaces,
      (SELECT count(DISTINCT block.parking_spot_id) FROM parking_spot_blocks block
        WHERE block.released_at IS NULL AND block.starts_at<=now() AND COALESCE(block.ends_at,'infinity'::timestamptz)>now())::int blocked_spaces,
      (SELECT COALESCE(sum((p.snapshot->>'totalCents')::int + COALESCE((SELECT sum(a.amount_cents) FROM parking_booking_price_adjustments a WHERE a.booking_id=b.id),0)),0)
        FROM parking_booking_price_snapshots p JOIN parking_bookings b ON b.id=p.booking_id
        WHERE b.created_at>=$1 AND b.created_at<$2
          AND b.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT','COMPLETED'))::int booked_value`, [periodStart, periodEnd, capacityStatuses()]);
    const areaMetrics = await areaCapacityMetrics(pool);
    const capacitySummary = areaMetrics.reduce((total, item) => ({
      available: total.available + item.availableCapacity,
      reserved: total.reserved + item.reservedCapacity,
      checkedIn: total.checkedIn + item.checkedInCapacity,
      shortfalls: total.shortfalls + (item.shortfall > 0 ? 1 : 0)
    }), { available: 0, reserved: 0, checkedIn: 0, shortfalls: 0 });
    summary.rows[0].available_spaces = capacitySummary.available;
    summary.rows[0].reserved_spaces = capacitySummary.reserved;
    summary.rows[0].checked_in = capacitySummary.checkedIn;
    summary.rows[0].capacity_shortfalls = capacitySummary.shortfalls;
    const activity = await pool.query(`SELECT h.created_at,h.new_status,b.reservation_number
      FROM parking_booking_status_history h JOIN parking_bookings b ON b.id=h.booking_id
      ORDER BY h.created_at DESC LIMIT 12`);
    const [currentCustomers, nextArrivals, currentDepartures, attention] = await Promise.all([
      pool.query(`SELECT b.id,b.reservation_number,b.parking_product,b.payment_status,
          customer.public_id customer_public_id,
          COALESCE(customer.display_name,customer.company_name,NULLIF(concat_ws(' ',customer.first_name,customer.last_name),''),
            NULLIF(concat_ws(' ',b.first_name,b.last_name),'')) customer_name,
          COALESCE(customer.display_phone,b.mobile_phone) customer_phone,
          b.license_plate,b.license_plate_state,b.tractor_unit_number,
          s.id assigned_spot_id,COALESCE(s.public_label,b.assigned_spot_label) assigned_spot_label,
          COALESCE(billing.status,b.payment_status,'NOT_DUE') billing_status,
          COALESCE(billing.balance_cents,0)::bigint balance_cents
        FROM parking_bookings b
        LEFT JOIN parking_customers customer ON customer.id=b.customer_id
        LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=b.id AND assignment.released_at IS NULL
        LEFT JOIN parking_spots s ON s.id=assignment.parking_spot_id
        LEFT JOIN LATERAL (SELECT aggregate.*,
            GREATEST(aggregate.amount_due_cents-aggregate.paid_cents,0)::bigint balance_cents,
            CASE WHEN aggregate.amount_due_cents=0 THEN 'NOT_DUE'
              WHEN aggregate.paid_cents>=aggregate.amount_due_cents THEN 'PAID'
              WHEN aggregate.paid_cents>0 THEN 'PARTIAL'
              WHEN aggregate.due_date<current_date THEN 'OVERDUE' ELSE 'DUE' END status
          FROM (SELECT balance.period_start,sum(balance.amount_due_cents)::bigint amount_due_cents,
              sum(balance.paid_cents)::bigint paid_cents,min(balance.due_date) due_date
            FROM parking_customer_billing_period_balances balance WHERE balance.customer_id=b.customer_id
            GROUP BY balance.period_start) aggregate
          ORDER BY (aggregate.period_start=date_trunc('month',current_date)::date) DESC,
            aggregate.period_start DESC LIMIT 1) billing ON true
        WHERE b.status IN ('CONFIRMED','CHECKED_IN') AND b.arrival_at<=now()
          AND (b.departure_at IS NULL OR b.departure_at>now()
            OR (b.parking_product='MONTHLY' AND b.billing_period_end_at>now()
              AND b.subscription_status IN ('ACTIVE','TRIALING','PAST_DUE','PAYMENT_ACTION_REQUIRED')))
        ORDER BY CASE WHEN COALESCE(s.public_label,b.assigned_spot_label) ~ '^[0-9]+$'
            THEN COALESCE(s.public_label,b.assigned_spot_label)::integer END,
          COALESCE(s.public_label,b.assigned_spot_label),b.id LIMIT 50`),
      pool.query(`SELECT b.id,b.reservation_number,b.arrival_at,b.status,l.name location_name,z.name area_name,
          b.assignment_mode_snapshot,COALESCE(s.public_label,b.assigned_spot_label) assigned_spot_label,
          s.id assigned_spot_id,customer.public_id customer_public_id,
          COALESCE(customer.display_name,customer.company_name,concat_ws(' ',b.first_name,b.last_name)) customer_name,
          b.license_plate,b.license_plate_state,b.tractor_unit_number
        FROM parking_bookings b JOIN parking_locations l ON l.id=b.location_id
        JOIN parking_inventory i ON i.id=b.inventory_id JOIN parking_zones z ON z.id=i.zone_id
        LEFT JOIN parking_customers customer ON customer.id=b.customer_id
        LEFT JOIN reservation_spot_assignments a ON a.booking_id=b.id AND a.released_at IS NULL
        LEFT JOIN parking_spots s ON s.id=a.parking_spot_id
        WHERE b.arrival_at>=now() AND b.status='CONFIRMED' ORDER BY b.arrival_at LIMIT 8`),
      pool.query(`SELECT b.id,b.reservation_number,b.departure_at,b.status,l.name location_name,z.name area_name,
          b.assignment_mode_snapshot,COALESCE(s.public_label,b.assigned_spot_label) assigned_spot_label,
          s.id assigned_spot_id,customer.public_id customer_public_id,
          COALESCE(customer.display_name,customer.company_name,concat_ws(' ',b.first_name,b.last_name)) customer_name,
          b.license_plate,b.license_plate_state,b.tractor_unit_number
        FROM parking_bookings b JOIN parking_locations l ON l.id=b.location_id
        JOIN parking_inventory i ON i.id=b.inventory_id JOIN parking_zones z ON z.id=i.zone_id
        LEFT JOIN parking_customers customer ON customer.id=b.customer_id
        LEFT JOIN reservation_spot_assignments a ON a.booking_id=b.id AND a.released_at IS NULL
        LEFT JOIN parking_spots s ON s.id=a.parking_spot_id
        WHERE b.status='CHECKED_IN' ORDER BY b.departure_at LIMIT 8`),
      pool.query(`SELECT b.id,b.reservation_number,b.status,b.arrival_at,b.departure_at,
          customer.public_id customer_public_id,
          COALESCE(customer.display_name,customer.company_name,concat_ws(' ',b.first_name,b.last_name)) customer_name,
          b.license_plate,b.license_plate_state,b.tractor_unit_number,
          s.id assigned_spot_id,COALESCE(s.public_label,b.assigned_spot_label) assigned_spot_label,
          CASE WHEN b.status='CHECKED_IN' AND b.departure_at<now() THEN 'OVERDUE'
            WHEN b.status='PENDING' AND b.payment_status='PAID' THEN 'PAID_ALLOCATION_REVIEW'
            WHEN b.status='PENDING' THEN 'PENDING_CONFIRMATION' ELSE 'ATTENTION' END attention_type
        FROM parking_bookings b LEFT JOIN parking_customers customer ON customer.id=b.customer_id
        LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=b.id AND assignment.released_at IS NULL
        LEFT JOIN parking_spots s ON s.id=assignment.parking_spot_id
        WHERE (b.status='CHECKED_IN' AND b.departure_at<now()) OR b.status='PENDING'
        ORDER BY CASE WHEN b.status='CHECKED_IN' THEN 0 ELSE 1 END,b.arrival_at LIMIT 12`)
    ]);
    res.json({ summary: summary.rows[0], period: { from: periodStart, to: periodEnd }, occupancy: areaMetrics.map(item => ({
      location: item.location, zone: item.area, category: item.area, capacity: item.physicalCapacity,
      usable_capacity: item.usablePhysical, reserved_capacity: item.reservedCapacity,
      checked_in: item.checkedInCapacity, blocked_physical: item.blockedPhysical,
      available_capacity: item.availableCapacity, shortfall: item.shortfall, closed: item.closed,
      exact_capacity: item.exactCapacity, customer_selected_capacity: item.customerSelectedCapacity,
      area_capacity: item.areaCapacity
    })), areaCapacity: areaMetrics,
      recentActivity: activity.rows, currentCustomers: currentCustomers.rows,
      nextArrivals: nextArrivals.rows, currentDepartures: currentDepartures.rows,
      attentionRequired: attention.rows });
  } catch (error) { next(error); }
});

router.get('/bookings', roles.read, async (req, res, next) => {
  try {
    const query = req.query;
    const limit = pageLimit(query.limit);
    const cursor = decodeCursor(query.cursor, ['arrivalAt', 'id']);
    const terms = [];
    const values = [];
    const add = (sql, value) => { values.push(value); terms.push(sql.replace('?', `$${values.length}`)); };
    if (query.q) {
      const like = `%${query.q}%`;
      const fields = ['b.reservation_number', 'b.first_name', 'b.last_name', 'b.mobile_phone', 'b.email',
        "COALESCE(b.company_name,'')", "COALESCE(b.usdot_number,'')", 'b.tractor_unit_number',
        "COALESCE(b.trailer_number,'')", 'b.license_plate', 'b.license_plate_state'];
      const matches = fields.map(field => { values.push(like); return `${field} ILIKE $${values.length}`; });
      terms.push(`(${matches.join(' OR ')})`);
    }
    if (query.status) {
      if (!bookingStatuses.includes(String(query.status))) throw apiError('VALIDATION_ERROR', 'Invalid booking status');
      add('b.status=?', query.status);
    }
    if (query.from) add('b.arrival_at >= ?', validTime(query.from, 'Start date'));
    if (query.to) add('b.arrival_at < ?', validTime(query.to, 'End date'));
    if (cursor) {
      values.push(validTime(cursor.arrivalAt, 'Cursor arrival'), wholeNumber(cursor.id, 'Cursor booking', { min: 1 }));
      terms.push(`(b.arrival_at,b.id)<($${values.length - 1}::timestamptz,$${values.length}::bigint)`);
    }
    const where = terms.length ? `WHERE ${terms.join(' AND ')}` : '';
    values.push(limit + 1);
    const bookings = await pool.query(`SELECT b.id,b.reservation_number,b.status,b.arrival_at,b.departure_at,
        b.first_name,b.last_name,b.mobile_phone,b.email,b.company_name,b.tractor_unit_number,b.trailer_number,
        b.license_plate,b.license_plate_state,b.version,b.assignment_mode_snapshot,b.parking_product,b.payment_status,
        b.subscription_status,b.billing_period_end_at,b.payment_grace_ends_at,
        customer.public_id customer_public_id,
        COALESCE(customer.display_name,customer.company_name,concat_ws(' ',customer.first_name,customer.last_name)) customer_display_name,
        customer.company_name customer_account_company_name,
        l.name location_name,l.timezone location_timezone,c.name category_name,z.name zone_name,p.snapshot,
        s.id assigned_spot_id,COALESCE(s.public_label,b.assigned_spot_label) assigned_spot_label,
        insurance.verification_status insurance_status,insurance.policy_expires_at insurance_expires_at,
        license.verification_status driver_license_status
      FROM parking_bookings b
      JOIN parking_locations l ON l.id=b.location_id
      JOIN parking_categories c ON c.id=b.category_id
      JOIN parking_inventory i ON i.id=b.inventory_id
      JOIN parking_zones z ON z.id=i.zone_id
      LEFT JOIN parking_booking_price_snapshots p ON p.booking_id=b.id
      LEFT JOIN parking_customers customer ON customer.id=b.customer_id
      LEFT JOIN reservation_spot_assignments a ON a.booking_id=b.id AND a.released_at IS NULL
      LEFT JOIN parking_spots s ON s.id=a.parking_spot_id
      LEFT JOIN LATERAL (SELECT verification_status,policy_expires_at FROM parking_customer_documents
        WHERE booking_id=b.id AND document_type IN ('INSURANCE','VEHICLE_CARRIER_INSURANCE')
          AND upload_status='UPLOADED' AND superseded_at IS NULL ORDER BY revision DESC,id DESC LIMIT 1) insurance ON true
      LEFT JOIN LATERAL (SELECT verification_status FROM parking_customer_documents
        WHERE booking_id=b.id AND document_type='DRIVER_LICENSE'
          AND upload_status='UPLOADED' AND superseded_at IS NULL ORDER BY revision DESC,id DESC LIMIT 1) license ON true
      ${where} ORDER BY b.arrival_at DESC,b.id DESC LIMIT $${values.length}`, values);
    const hasMore = bookings.rows.length > limit;
    const rows = bookings.rows.slice(0, limit);
    const last = rows.at(-1);
    res.json({ bookings: rows, pagination: { limit, hasMore,
      nextCursor: hasMore && last ? encodeCursor({ arrivalAt: new Date(last.arrival_at).toISOString(), id: Number(last.id) }) : null } });
  } catch (error) { next(error); }
});

router.patch('/customer-accounts/:publicId/recovery', csrf, roles.owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const contactType = String(req.body.contactType || '').toUpperCase();
    if (!['PHONE', 'EMAIL'].includes(contactType)) throw apiError('VALIDATION_ERROR', 'Choose phone or email recovery');
    if (req.body.verifiedOwnership !== true) {
      throw apiError('VERIFIED_OWNERSHIP_REQUIRED', 'Confirm ownership was verified outside this session before changing a login identity', 409);
    }
    const reason = cleanText(req.body.reason, 1000, 'Recovery reason', true);
    const verificationReference = cleanText(req.body.verificationReference, 160, 'Verification reference', true);
    const normalized = contactType === 'PHONE'
      ? customerIdentity.normalizePhone(req.body.identifier)
      : customerIdentity.normalizeEmail(req.body.identifier);
    await client.query('BEGIN');
    const customer = (await client.query(`SELECT * FROM parking_customers
      WHERE public_id=$1 FOR UPDATE`, [req.params.publicId])).rows[0];
    if (!customer) throw apiError('NOT_FOUND', 'Customer account not found', 404);
    const column = contactType === 'PHONE' ? 'normalized_phone' : 'normalized_email';
    const conflicting = (await client.query(`SELECT id FROM parking_customers
      WHERE ${column}=$1 AND id<>$2 FOR UPDATE`, [normalized, customer.id])).rows[0];
    if (conflicting) {
      const phoneCustomerId = contactType === 'PHONE' ? conflicting.id : customer.id;
      const emailCustomerId = contactType === 'EMAIL' ? conflicting.id : customer.id;
      const conflict = (await client.query(`INSERT INTO parking_customer_identity_conflicts(
          phone_customer_id,email_customer_id)
        VALUES($1,$2)
        ON CONFLICT (phone_customer_id,email_customer_id) WHERE status='OPEN'
        DO UPDATE SET occurrence_count=parking_customer_identity_conflicts.occurrence_count+1,last_detected_at=now()
        RETURNING id`, [phoneCustomerId, emailCustomerId])).rows[0];
      await client.query("UPDATE parking_customers SET status='RECOVERY_REQUIRED' WHERE id=$1", [customer.id]);
      await audit(req, 'CUSTOMER_RECOVERY_CONFLICT', 'parking_customer', customer.public_id, {
        contactType, conflictId: Number(conflict.id), reason, verificationReference
      }, client);
      await client.query('COMMIT');
      return res.status(409).json({ error: { code: 'CUSTOMER_IDENTITY_CONFLICT', message: 'That verified contact belongs to another account. The accounts were not merged; review is required.' } });
    }
    const displayColumn = contactType === 'PHONE' ? 'display_phone' : 'display_email';
    const verifiedColumn = contactType === 'PHONE' ? 'phone_verified_at' : 'email_verified_at';
    await client.query(`UPDATE parking_customers SET ${column}=$1,${displayColumn}=$2,
        ${verifiedColumn}=now(),status='ACTIVE' WHERE id=$3`, [normalized, cleanText(req.body.identifier, 254, 'Login identity', true), customer.id]);
    await client.query('UPDATE parking_customer_sessions SET revoked_at=now() WHERE customer_id=$1 AND revoked_at IS NULL', [customer.id]);
    if (req.body.conflictId !== undefined && req.body.conflictId !== null && req.body.conflictId !== '') {
      const conflictId = wholeNumber(req.body.conflictId, 'Conflict', { min: 1 });
      await client.query(`UPDATE parking_customer_identity_conflicts SET status='RESOLVED',resolved_by_admin_user_id=$1,
          resolved_at=now(),resolution_note=$2 WHERE id=$3 AND status='OPEN'
          AND (phone_customer_id=$4 OR email_customer_id=$4)`, [req.admin.id, reason, conflictId, customer.id]);
    }
    const masked = customerIdentity.maskIdentifier({ channel: contactType === 'PHONE' ? 'SMS' : 'EMAIL', normalized });
    await audit(req, 'CUSTOMER_LOGIN_IDENTITY_RECOVERED', 'parking_customer', customer.public_id, {
      contactType, maskedIdentifier: masked, reason, verificationReference, sessionsRevoked: true
    }, client);
    await client.query('COMMIT');
    res.json({ customer: { publicId: customer.public_id, contactType, maskedIdentifier: masked, status: 'ACTIVE' } });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.get('/calendar', roles.read, async (req, res, next) => {
  try {
    const lot = req.query.locationId
      ? (await pool.query('SELECT id,name,timezone FROM parking_locations WHERE id=$1 AND active',
        [wholeNumber(req.query.locationId, 'Location', { min: 1 })])).rows[0]
      : await resolveCanonicalLot(pool);
    if (!lot) throw apiError('NOT_FOUND', 'Parking lot not found', 404);
    const startDate = localDate(req.query.startDate, 'Calendar start date');
    const endDate = localDate(req.query.endDate, 'Calendar end date');
    const start = DateTime.fromISO(startDate, { zone: lot.timezone }).startOf('day');
    const end = DateTime.fromISO(endDate, { zone: lot.timezone }).startOf('day');
    if (!start.isValid || !end.isValid || end <= start) throw apiError('VALIDATION_ERROR', 'Calendar end date must be after its start date');
    if (end.diff(start, 'days').days > 31) throw apiError('CALENDAR_RANGE_TOO_LARGE', 'Calendar ranges cannot exceed 31 local days', 422);
    const limit = pageLimit(req.query.limit, 100, 500);
    const cursor = decodeCursor(req.query.cursor, ['eventAt', 'bookingId', 'type']);
    const values = [lot.id, start.toUTC().toISO(), end.toUTC().toISO(), lot.timezone];
    let cursorSql = '';
    if (cursor) {
      values.push(validTime(cursor.eventAt, 'Cursor event time'), wholeNumber(cursor.bookingId, 'Cursor booking', { min: 1 }), String(cursor.type));
      cursorSql = `WHERE (event_at,booking_id,event_type)>($5::timestamptz,$6::bigint,$7::text)`;
    }
    values.push(limit + 1);
    const events = await pool.query(`WITH events AS (
        SELECT b.id booking_id,b.reservation_number,b.status,b.first_name,b.last_name,b.company_name,
          b.assignment_mode_snapshot,c.name parking_area,b.assigned_spot_label,b.arrival_at event_at,'ARRIVAL'::text event_type
        FROM parking_bookings b JOIN parking_categories c ON c.id=b.category_id
        WHERE b.location_id=$1 AND b.arrival_at>=$2 AND b.arrival_at<$3
        UNION ALL
        SELECT b.id,b.reservation_number,b.status,b.first_name,b.last_name,b.company_name,
          b.assignment_mode_snapshot,c.name,b.assigned_spot_label,b.departure_at,'DEPARTURE'::text
        FROM parking_bookings b JOIN parking_categories c ON c.id=b.category_id
        WHERE b.location_id=$1 AND b.departure_at>=$2 AND b.departure_at<$3
      ), authoritative AS (
        SELECT events.*,to_char(event_at AT TIME ZONE $4,'YYYY-MM-DD') local_date,
          count(*) OVER()::int total_events FROM events
      ) SELECT * FROM authoritative ${cursorSql}
      ORDER BY event_at,booking_id,event_type LIMIT $${values.length}`, values);
    const hasMore = events.rows.length > limit;
    const rows = events.rows.slice(0, limit);
    const last = rows.at(-1);
    res.json({ timezone: lot.timezone, range: { startDate, endDate }, totalEvents: rows[0]?.total_events || 0,
      events: rows.map(row => ({ bookingId: Number(row.booking_id), reservationNumber: row.reservation_number,
        status: row.status, customerName: `${row.first_name} ${row.last_name}`.trim(), assignedSpace: row.assigned_spot_label,
        companyName: row.company_name,
        assignmentMode: row.assignment_mode_snapshot, parkingArea: row.parking_area,
        type: row.event_type, at: row.event_at, localDate: row.local_date })),
      pagination: { limit, hasMore, nextCursor: hasMore && last ? encodeCursor({
        eventAt: new Date(last.event_at).toISOString(), bookingId: Number(last.booking_id), type: last.event_type
      }) : null } });
  } catch (error) { next(error); }
});

router.get('/bookings/:id', roles.read, async (req, res, next) => {
  try {
    const booking = await pool.query(`SELECT b.*,l.name location_name,l.arrival_instructions,c.name category_name,z.name zone_name,p.snapshot
      FROM parking_bookings b
      JOIN parking_locations l ON l.id=b.location_id
      JOIN parking_categories c ON c.id=b.category_id
      JOIN parking_inventory i ON i.id=b.inventory_id
      JOIN parking_zones z ON z.id=i.zone_id
      JOIN parking_booking_price_snapshots p ON p.booking_id=b.id WHERE b.id=$1`, [req.params.id]);
    if (!booking.rowCount) throw apiError('NOT_FOUND', 'Booking not found', 404);
    const [history, notes, adjustments, assignments, documents, customerAccount] = await Promise.all([
      pool.query(`SELECT h.*,u.username FROM parking_booking_status_history h LEFT JOIN parking_admin_users u ON u.id=h.admin_user_id
        WHERE h.booking_id=$1 ORDER BY h.created_at`, [req.params.id]),
      pool.query(`SELECT n.*,u.username FROM parking_booking_notes n LEFT JOIN parking_admin_users u ON u.id=n.admin_user_id
        WHERE n.booking_id=$1 ORDER BY n.created_at`, [req.params.id]),
      pool.query(`SELECT a.*,u.username FROM parking_booking_price_adjustments a JOIN parking_admin_users u ON u.id=a.admin_user_id
        WHERE a.booking_id=$1 ORDER BY a.created_at`, [req.params.id]),
      pool.query(`SELECT a.*,s.public_label,z.name area_name,u.username assigned_by
        FROM reservation_spot_assignments a JOIN parking_spots s ON s.id=a.parking_spot_id
        JOIN parking_zones z ON z.id=s.zone_id LEFT JOIN parking_admin_users u ON u.id=a.assigned_by_admin_user_id
        WHERE a.booking_id=$1 ORDER BY a.assigned_at,a.id`, [req.params.id]),
      pool.query(`SELECT public_id,
          CASE WHEN document_type='VEHICLE_CARRIER_INSURANCE' THEN 'INSURANCE' ELSE document_type END document_type,
          upload_status,verification_status,policy_expires_at,review_note,uploaded_at,reviewed_at,
          original_filename,declared_mime_type,revision
        FROM parking_customer_documents WHERE booking_id=$1 AND upload_status='UPLOADED' AND superseded_at IS NULL
        ORDER BY document_type,revision DESC,id DESC`, [req.params.id]),
      booking.rows[0].customer_id ? pool.query(`SELECT c.public_id,c.display_name,c.company_name,c.first_name,c.last_name,c.display_phone,c.display_email,
          c.usdot_number,c.mc_number,
          c.phone_verified_at,c.email_verified_at,c.status,c.created_at,
          (SELECT count(*)::int FROM parking_bookings linked WHERE linked.customer_id=c.id) reservation_count,
          (SELECT count(*)::int FROM parking_customer_vehicles v WHERE v.customer_id=c.id AND v.active) vehicle_count,
          (SELECT count(*)::int FROM parking_customer_payments pay WHERE pay.customer_id=c.id AND pay.status='PAID') paid_payment_count,
          (SELECT count(*)::int FROM parking_customer_identity_conflicts conflict
            WHERE conflict.status='OPEN' AND (conflict.phone_customer_id=c.id OR conflict.email_customer_id=c.id)) open_conflict_count,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'reservationNumber',recent.reservation_number,'product',recent.parking_product,'status',recent.status,
            'paymentStatus',recent.payment_status,'subscriptionStatus',recent.subscription_status,
            'arrivalAt',recent.arrival_at,'departureAt',recent.departure_at,'space',recent.assigned_spot_label)
            ORDER BY recent.arrival_at DESC)
            FROM (SELECT * FROM parking_bookings linked WHERE linked.customer_id=c.id ORDER BY linked.arrival_at DESC LIMIT 8) recent),'[]'::jsonb) reservations,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('unitNumber',v.unit_number,'licensePlate',v.license_plate,
            'licensePlateState',v.license_plate_state,'classification',v.vehicle_classification,'lastUsedAt',v.last_used_at)
            ORDER BY v.last_used_at DESC NULLS LAST,v.id DESC) FROM parking_customer_vehicles v
            WHERE v.customer_id=c.id AND v.active),'[]'::jsonb) vehicles,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'type',CASE WHEN d.document_type='VEHICLE_CARRIER_INSURANCE' THEN 'INSURANCE' ELSE d.document_type END,
            'uploadStatus',d.upload_status,
            'verificationStatus',d.verification_status,'expiresAt',d.policy_expires_at,'uploadedAt',d.uploaded_at)
            ORDER BY d.created_at DESC) FROM parking_customer_documents d JOIN parking_bookings linked ON linked.id=d.booking_id
            WHERE linked.customer_id=c.id AND d.upload_status='UPLOADED' AND d.superseded_at IS NULL),'[]'::jsonb) documents
        FROM parking_customers c WHERE c.id=$1`, [booking.rows[0].customer_id]) : Promise.resolve({ rows: [] })
    ]);
    const account = customerAccount.rows[0];
    res.json({ booking: booking.rows[0], history: history.rows, notes: notes.rows, adjustments: adjustments.rows, assignments: assignments.rows, documents: documents.rows,
      customerAccount: account ? {
        publicId: account.public_id, displayName: account.display_name, companyName: account.company_name,
        firstName: account.first_name, lastName: account.last_name, usdotNumber: account.usdot_number, mcNumber: account.mc_number,
        phone: account.display_phone, email: account.display_email,
        phoneVerified: Boolean(account.phone_verified_at), emailVerified: Boolean(account.email_verified_at),
        status: account.status, createdAt: account.created_at, reservationCount: Number(account.reservation_count),
        vehicleCount: Number(account.vehicle_count), paidPaymentCount: Number(account.paid_payment_count),
        openConflictCount: Number(account.open_conflict_count), reservations: account.reservations,
        vehicles: account.vehicles, documents: account.documents
      } : null });
  } catch (error) { next(error); }
});

async function transition(req, res, next, target) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM parking_bookings WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!found.rowCount) throw apiError('NOT_FOUND', 'Booking not found', 404);
    const booking = found.rows[0];
    if (target === 'CONFIRMED') {
      if (!payOnSite() || booking.payment_status !== 'NOT_REQUIRED') {
        throw apiError('PAYMENT_FINALIZATION_REQUIRED', 'Only verified Stripe payment or an authorized QA bypass can finalize parking inventory', 409);
      }
      if (Number(booking.version) !== version(req.body)) throw apiError('BOOKING_VERSION_CONFLICT', 'This reservation changed; refresh and try again', 409);
      const categoryCode = (await client.query('SELECT code FROM parking_categories WHERE id=$1', [booking.category_id])).rows[0]?.code;
      const confirmed = await confirmOnSiteBooking(client, { ...booking, category_code: categoryCode }, {
        actorType: 'ADMIN', adminUserId: req.admin.id, reason: 'Confirmed by staff for payment on site',
        note: cleanText(req.body.note, 1000, 'Note') || null
      });
      await audit(req, 'BOOKING_CONFIRMED', 'booking', booking.id, { paymentMode: 'PAY_ON_SITE' }, client);
      await client.query('COMMIT');
      return res.json({ status: 'CONFIRMED', version: Number(confirmed.version) });
    }
    if (Number(booking.version) !== version(req.body)) throw apiError('BOOKING_VERSION_CONFLICT', 'This reservation changed; refresh and try again', 409);
    assertTransition(booking.status, target);
    let weeklyCancellation = null; let weeklyCancellationScheduled = false;
    if (target === 'CHECKED_OUT' && isOpenEndedWeekly(booking) && booking.stripe_subscription_id
        && !booking.subscription_cancel_at_period_end) {
      const subscription = await stripeGateway.scheduleSubscriptionCancellation(booking.stripe_subscription_id,
        `parkingops-weekly-end:${booking.id}:${booking.version}`);
      weeklyCancellationScheduled = true;
      const periodEndSeconds = Number(subscription?.current_period_end || subscription?.items?.data?.[0]?.current_period_end);
      weeklyCancellation = Number.isFinite(periodEndSeconds) && periodEndSeconds > 0
        ? new Date(periodEndSeconds * 1000).toISOString() : booking.billing_period_end_at;
    }
    if (target === 'CHECKED_IN' && booking.departure_at && new Date(booking.departure_at) <= new Date()) {
      throw apiError('BOOKING_TRANSITION_NOT_ALLOWED', 'Cannot check in an expired booking', 409);
    }
    const narrative = requireNarrative(req.body, target);
    const values = [target, booking.id, booking.version];
    let set = 'status=$1,version=version+1,updated_at=now()';
    if (booking.status === 'PENDING') set += ',pending_expires_at=NULL';
    if (target === 'CHECKED_IN') {
      if (booking.assignment_mode_snapshot === 'ZONE_CAPACITY'
        && (req.body.assignedZoneId || req.body.assignedSpotLabel)) {
        throw apiError('AREA_CAPACITY_HAS_NO_EXACT_SPOT', 'Parking-area reservations cannot receive an exact numbered-space assignment', 409);
      }
      set += ',actual_arrival_at=COALESCE($4,now()),assigned_zone_id=COALESCE($5,assigned_zone_id),assigned_spot_label=COALESCE($6,assigned_spot_label),check_in_policy_acknowledged_at=CASE WHEN $7::boolean THEN now() ELSE check_in_policy_acknowledged_at END,check_in_condition_note=COALESCE($8,check_in_condition_note)';
      values.push(req.body.actualArrivalAt ? validTime(req.body.actualArrivalAt, 'Actual arrival') : null,
        req.body.assignedZoneId || null, cleanText(req.body.assignedSpotLabel, 80, 'Spot label'),
        req.body.policyAcknowledged === true, cleanText(req.body.conditionNote, 1000, 'Condition note'));
    }
    if (target === 'CHECKED_OUT') {
      set += ',actual_departure_at=COALESCE($4,now())';
      values.push(req.body.actualDepartureAt ? validTime(req.body.actualDepartureAt, 'Actual departure') : null);
    }
    await client.query(`UPDATE parking_bookings SET ${set} WHERE id=$2 AND version=$3`, values);
    if (weeklyCancellationScheduled) {
      await client.query(`UPDATE parking_bookings SET subscription_cancel_at_period_end=true,
        billing_period_end_at=COALESCE($2,billing_period_end_at),updated_at=now() WHERE id=$1`,
      [booking.id, weeklyCancellation]);
    }
    await client.query(`INSERT INTO parking_booking_status_history
      (booking_id,previous_status,new_status,actor_type,admin_user_id,reason,note,version)
      VALUES($1,$2,$3,'ADMIN',$4,$5,$6,$7)`, [booking.id, booking.status, target, req.admin.id,
      narrative.reason, narrative.note, Number(booking.version) + 1]);
    if (narrative.note) await client.query(`INSERT INTO parking_booking_notes(booking_id,admin_user_id,visibility,note)
      VALUES($1,$2,'INTERNAL',$3)`, [booking.id, req.admin.id, narrative.note]);
    const assignment = await currentAssignment(client, booking.id, { lock: true });
    if (assignment && target === 'CHECKED_IN') await recordAssignmentArrival(client, booking.id, req.body.actualArrivalAt || null);
    if (assignment && target === 'CHECKED_OUT') {
      await recordAssignmentDeparture(client, booking.id, req.body.actualDepartureAt || null);
      await releaseCurrentAssignment(client, booking.id, 'Reservation checked out');
    }
    if (assignment && ['CANCELLED', 'NO_SHOW', 'EXPIRED'].includes(target)) await releaseCurrentAssignment(client, booking.id, `Reservation ${target.toLowerCase().replace('_', ' ')}`);
    await audit(req, `BOOKING_${target}`, 'booking', booking.id,
      weeklyCancellationScheduled ? { weeklyRecurringBillingStopsAt: weeklyCancellation } : {}, client);
    await client.query('COMMIT');
    res.json({ status: target, version: Number(booking.version) + 1 });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
}

for (const [path, target, role] of [
  ['confirm', 'CONFIRMED', 'operate'], ['check-in', 'CHECKED_IN', 'operate'], ['check-out', 'CHECKED_OUT', 'operate'],
  ['complete', 'COMPLETED', 'operate'], ['cancel', 'CANCELLED', 'operate'], ['no-show', 'NO_SHOW', 'operate']
]) router.post(`/bookings/:id/${path}`, csrf, roles[role], (req, res, next) => transition(req, res, next, target));

router.get('/bookings/:id/spot-alternatives', roles.operate, async (req, res, next) => {
  try {
    const booking = (await pool.query(`SELECT b.*,l.turnaround_buffer_minutes FROM parking_bookings b
      JOIN parking_locations l ON l.id=b.location_id WHERE b.id=$1`, [req.params.id])).rows[0];
    if (!booking) throw apiError('NOT_FOUND', 'Reservation not found', 404);
    if (booking.assignment_mode_snapshot === 'ZONE_CAPACITY') throw apiError('AREA_CAPACITY_HAS_NO_EXACT_SPOT', 'Parking-area reservations do not use numbered-space reassignment', 409);
    if (!BLOCKING_STATUSES.includes(booking.status)) throw apiError('SPOT_NOT_ELIGIBLE', 'Only confirmed or checked-in reservations can be reassigned', 409);
    const current = await currentAssignment(pool, booking.id);
    if (!current) throw apiError('SPOT_NOT_ELIGIBLE', 'This reservation has no current numbered space', 409);
    const alternatives = await eligibleReassignmentSpots(pool, booking, current);
    res.json({ current, alternatives: alternatives.rows.map(item => ({ id: item.id, public_label: item.public_label, area_name: item.area_name })) });
  } catch (error) { next(error); }
});

router.post('/bookings/:id/reassign-spot', csrf, roles.operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const replacementSpotId = wholeNumber(req.body.spotId, 'Replacement space', { min: 1 });
    const reason = cleanText(req.body.reason, 500, 'Reassignment reason', true);
    await client.query('BEGIN');
    const mode = await client.query('SELECT assignment_mode_snapshot FROM parking_bookings WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!mode.rowCount) throw apiError('NOT_FOUND', 'Reservation not found', 404);
    if (mode.rows[0].assignment_mode_snapshot === 'ZONE_CAPACITY') throw apiError('AREA_CAPACITY_HAS_NO_EXACT_SPOT', 'Parking-area reservations do not use numbered-space reassignment', 409);
    const result = await reassignSpot(client, { bookingId: req.params.id, replacementSpotId, adminUserId: req.admin.id,
      reason, bookingVersion: version(req.body) });
    await client.query(`INSERT INTO parking_booking_notes(booking_id,admin_user_id,visibility,note)
      VALUES($1,$2,'INTERNAL',$3)`, [req.params.id, req.admin.id, `Space reassigned from ${result.previous.public_label} to ${result.spot.public_label}: ${reason}`]);
    await audit(req, 'REASSIGN_SPOT', 'booking', req.params.id, {
      fromSpotId: result.previous.parking_spot_id, toSpotId: result.spot.id, reason
    }, client);
    await client.query('COMMIT');
    res.json({ assignedSpace: result.spot.public_label, assignment: result.assignment });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

// Daily / Weekly drivers book the area and get no numbered space. These are the ones who have
// not been placed on a space yet, for the Live Lot "place an arriving driver here" control.
router.get('/unplaced-bookings', roles.read, async (req, res, next) => {
  try {
    const rows = (await pool.query(`SELECT b.id,b.reservation_number,b.parking_product,b.status,b.arrival_at,b.departure_at,b.version,
        b.inventory_id,b.category_id,c.code category_code,
        COALESCE(NULLIF(concat_ws(' ',b.first_name,b.last_name),''),b.company_name) customer_name,
        b.company_name,b.mobile_phone,b.license_plate,b.license_plate_state,b.tractor_unit_number
      FROM parking_bookings b JOIN parking_categories c ON c.id=b.category_id
      WHERE b.assignment_mode_snapshot='ZONE_CAPACITY' AND b.status IN ('CONFIRMED','CHECKED_IN')
        AND b.arrival_at<=now()+interval '2 days' AND (b.departure_at IS NULL OR b.departure_at>now()-interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM reservation_spot_assignments a WHERE a.booking_id=b.id AND a.released_at IS NULL)
      ORDER BY b.arrival_at,b.id LIMIT 200`)).rows;
    res.json({ bookings: rows.map(row => ({ ...row, id: Number(row.id), version: Number(row.version) })) });
  } catch (error) { next(error); }
});

// Place an area (Daily / Weekly) reservation on a numbered space. From then on it is a
// numbered-space reservation: it shows on the Live Lot and can be moved like any other.
router.post('/bookings/:id/place', csrf, roles.operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const spotId = wholeNumber(req.body.spotId, 'Space', { min: 1 });
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const found = await client.query('SELECT * FROM parking_bookings WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!found.rowCount) throw apiError('NOT_FOUND', 'Reservation not found', 404);
    const booking = found.rows[0];
    if (Number(booking.version) !== version(req.body)) throw apiError('BOOKING_VERSION_CONFLICT', 'This reservation changed; refresh and try again', 409);
    if (booking.assignment_mode_snapshot !== 'ZONE_CAPACITY') throw apiError('BOOKING_ALREADY_PLACED', 'This reservation already has a numbered space; use Move instead', 409);
    if (!['CONFIRMED', 'CHECKED_IN'].includes(booking.status)) throw apiError('BOOKING_TRANSITION_NOT_ALLOWED', 'Only confirmed or checked-in reservations can be placed on a space', 409);
    const updated = (await client.query(`UPDATE parking_bookings SET assignment_mode_snapshot='CUSTOMER_SELECTED_SPOT',
        version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [booking.id])).rows[0];
    const slot = await assertFinalBookingAvailability(client, updated);
    const spot = await selectExactSpot(client, { slot, arrival: updated.arrival_at,
      departure: updated.departure_at || monthlyOccupancyEnd(), preferredSpotId: spotId });
    if (Number(spot.id) !== spotId) throw apiError('SPACE_UNAVAILABLE', 'That space is not open for these dates', 409);
    const assignment = await assignSelectedExactSpot(client, { booking: updated, slot, spot, source: 'ADMIN_REASSIGN',
      adminUserId: req.admin.id, reason: 'Placed on a space from the Live Lot' });
    await client.query(`INSERT INTO parking_booking_notes(booking_id,admin_user_id,visibility,note)
      VALUES($1,$2,'INTERNAL',$3)`, [booking.id, req.admin.id, `Placed on space ${spot.public_label} from the Live Lot`]);
    await audit(req, 'PLACE_ON_SPACE', 'booking', booking.id, { spotId: Number(spot.id), label: spot.public_label }, client);
    await client.query('COMMIT');
    res.json({ assignedSpace: spot.public_label, assignment });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (['40001', '23505', '23P01'].includes(error.code)) return next(apiError('SPACE_UNAVAILABLE', 'That space was just taken. Pick another one.', 409));
    next(error);
  } finally { client.release(); }
});

router.post('/bookings/:id/notes', csrf, roles.operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const note = cleanText(req.body.note, 1000, 'Note', true);
    const visibility = req.body.visibility === 'CUSTOMER' ? 'CUSTOMER' : 'INTERNAL';
    await client.query('BEGIN');
    await client.query(`INSERT INTO parking_booking_notes(booking_id,admin_user_id,visibility,note)
      VALUES($1,$2,$3,$4)`, [req.params.id, req.admin.id, visibility, note]);
    await audit(req, 'CREATE_NOTE', 'booking', req.params.id, { visibility }, client);
    await client.query('COMMIT');
    res.status(201).json({ ok: true });
  } catch (error) { await client.query('ROLLBACK'); next(error); }
  finally { client.release(); }
});

router.post('/bookings/:id/adjustments', csrf, roles.configure, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const currentVersion = version(req.body);
    const type = String(req.body.adjustmentType || '').toUpperCase();
    if (!['DISCOUNT', 'MANUAL_ADJUSTMENT', 'ADDITIONAL_CHARGE'].includes(type)) throw apiError('VALIDATION_ERROR', 'Choose a valid adjustment type');
    const submittedAmount = Number(req.body.amountCents);
    if (!Number.isInteger(submittedAmount) || submittedAmount === 0) throw apiError('VALIDATION_ERROR', 'Adjustment amount must be non-zero whole cents');
    const amount = type === 'DISCOUNT' ? -Math.abs(submittedAmount) : type === 'ADDITIONAL_CHARGE' ? Math.abs(submittedAmount) : submittedAmount;
    const reason = cleanText(req.body.reason, 1000, 'Adjustment reason', true);
    await client.query('BEGIN');
    const booking = await client.query('SELECT id,version FROM parking_bookings WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!booking.rowCount) throw apiError('NOT_FOUND', 'Booking not found', 404);
    if (Number(booking.rows[0].version) !== currentVersion) throw apiError('BOOKING_VERSION_CONFLICT', 'This reservation changed; refresh and try again', 409);
    const adjustment = await client.query(`INSERT INTO parking_booking_price_adjustments
      (booking_id,adjustment_type,amount_cents,reason,admin_user_id)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [booking.rows[0].id, type, amount, reason, req.admin.id]);
    await client.query('UPDATE parking_bookings SET version=version+1,updated_at=now() WHERE id=$1 AND version=$2', [booking.rows[0].id, currentVersion]);
    await audit(req, 'CREATE_PRICE_ADJUSTMENT', 'booking', booking.rows[0].id, { type, amountCents: amount }, client);
    await client.query('COMMIT');
    res.status(201).json({ item: adjustment.rows[0], version: currentVersion + 1 });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.patch('/bookings/:id', csrf, roles.operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const allowed = ['first_name', 'last_name', 'mobile_phone', 'email', 'company_name', 'tractor_unit_number', 'license_plate',
      'license_plate_state', 'trailer_number', 'special_instructions', 'assigned_zone_id', 'assigned_spot_label', 'operational_notes'];
    const fields = allowed.filter(key => req.body[key] !== undefined);
    if (!fields.length) throw apiError('VALIDATION_ERROR', 'No permitted booking fields were provided');
    if (fields.some(key => ['assigned_zone_id', 'assigned_spot_label'].includes(key))) {
      const mode = await client.query('SELECT assignment_mode_snapshot FROM parking_bookings WHERE id=$1', [req.params.id]);
      if (!mode.rowCount) throw apiError('NOT_FOUND', 'Booking not found', 404);
      if (mode.rows[0].assignment_mode_snapshot === 'ZONE_CAPACITY') throw apiError('AREA_CAPACITY_HAS_NO_EXACT_SPOT', 'Parking-area reservations cannot receive a numbered-space assignment', 409);
      const authoritative = await client.query(`SELECT 1 FROM reservation_spot_assignments
        WHERE booking_id=$1 AND released_at IS NULL LIMIT 1`, [req.params.id]);
      if (authoritative.rowCount) throw apiError('EXACT_ASSIGNMENT_REQUIRES_REASSIGNMENT', 'Use Reassign space to change an exact numbered-space assignment', 409);
    }
    const currentVersion = version(req.body);
    const values = fields.map(key => {
      if (key === 'mobile_phone') return phone(req.body[key]);
      if (key === 'email') return email(req.body[key]);
      if (key === 'assigned_zone_id') return req.body[key] ? wholeNumber(req.body[key], 'Assigned zone', { min: 1 }) : null;
      if (['license_plate', 'license_plate_state'].includes(key)) return cleanText(req.body[key], key === 'license_plate' ? 30 : 40, key.replaceAll('_', ' '), true).toUpperCase();
      const limits = { first_name: 80, last_name: 80, company_name: 120, tractor_unit_number: 80, trailer_number: 80, assigned_spot_label: 80, special_instructions: 1000, operational_notes: 4000 };
      // Company / carrier is optional for Daily and Weekly drivers (same rule as online booking).
      const required = ['first_name', 'last_name', 'tractor_unit_number'].includes(key);
      const value = key === 'company_name' ? String(req.body[key] || '').replace(/\s+/g, ' ') : req.body[key];
      return cleanText(value, limits[key], key === 'company_name' ? 'Company / Carrier name' : key.replaceAll('_', ' '), required);
    });
    values.push(req.params.id, currentVersion);
    await client.query('BEGIN');
    const updated = await client.query(`UPDATE parking_bookings SET ${fields.map((key, index) => `${key}=$${index + 1}`).join(',')},
      version=version+1,updated_at=now() WHERE id=$${fields.length + 1} AND version=$${fields.length + 2}
      RETURNING id,version`, values);
    if (!updated.rowCount) throw apiError('BOOKING_VERSION_CONFLICT', 'This reservation changed; refresh and try again', 409);
    await audit(req, 'UPDATE_BOOKING', 'booking', req.params.id, { fields }, client);
    await client.query('COMMIT');
    res.json({ booking: updated.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); next(error); }
  finally { client.release(); }
});

router.post('/closures', csrf, roles.configure, async (req, res, next) => {
  const client = await pool.connect();
  try {
    validateClosure(req.body);
    const columns = config.closures.columns;
    const values = columns.map(key => req.body[key] === undefined ? (key === 'capacity_reduction' ? 0 : key === 'active' ? true : null) : req.body[key]);
    await client.query('BEGIN');
    await lockClosureInventories(client, req.body);
    const created = await client.query(`INSERT INTO parking_closures(${columns.join(',')})
      VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')}) RETURNING *`, values);
    const affected = await affectedBookings(client, created.rows[0]);
    await audit(req, 'CREATE', 'closure', created.rows[0].id, { affectedBookings: affected.length }, client);
    await client.query('COMMIT');
    res.status(201).json({ item: created.rows[0], affectedBookings: affected });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.patch('/inventory/:id', csrf, roles.configure, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const currentVersion = version(req.body);
    const columns = config.inventory.columns.filter(key => req.body[key] !== undefined);
    if (!columns.length) throw apiError('VALIDATION_ERROR', 'Provide configuration fields');
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [req.params.id]);
    const current = await client.query('SELECT * FROM parking_inventory WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!current.rowCount) throw apiError('NOT_FOUND', 'Inventory not found', 404);
    const inventory = current.rows[0];
    if (Number(inventory.version) !== currentVersion) throw apiError('BOOKING_VERSION_CONFLICT', 'Inventory changed; refresh and try again', 409);
    const nextCapacity = req.body.capacity === undefined ? Number(inventory.capacity) : wholeNumber(req.body.capacity, 'Capacity');
    const reassigned = (req.body.zone_id !== undefined && Number(req.body.zone_id) !== Number(inventory.zone_id))
      || (req.body.category_id !== undefined && Number(req.body.category_id) !== Number(inventory.category_id));
    if (reassigned) {
      const dependencies = await client.query(`SELECT EXISTS(
        SELECT 1 FROM parking_bookings WHERE inventory_id=$1
        UNION ALL SELECT 1 FROM parking_closures WHERE inventory_id=$1
      ) in_use`, [inventory.id]);
      if (dependencies.rows[0].in_use) throw apiError('CONFIGURATION_IN_USE', 'Inventory with booking or closure history cannot be reassigned', 409);
    }
    const peak = await client.query(`WITH points AS (
        SELECT now() point
        UNION SELECT arrival_at FROM parking_bookings
          WHERE inventory_id=$1 AND status=ANY($2::text[]) AND departure_at>now()
      ) SELECT COALESCE(MAX((SELECT count(*) FROM parking_bookings b
        WHERE b.inventory_id=$1 AND b.status=ANY($2::text[]) AND b.arrival_at<=points.point AND b.departure_at>points.point)),0)::int used
      FROM points`, [inventory.id, capacityStatuses()]);
    if (nextCapacity < Number(peak.rows[0].used)) throw apiError('CAPACITY_BELOW_RESERVED', 'Capacity cannot be reduced below peak active or future reservations', 409);
    const values = columns.map(key => key === 'capacity' ? nextCapacity : req.body[key]);
    values.push(inventory.id, currentVersion);
    const updated = await client.query(`UPDATE parking_inventory SET ${columns.map((key, index) => `${key}=$${index + 1}`).join(',')},
      version=version+1 WHERE id=$${columns.length + 1} AND version=$${columns.length + 2} RETURNING *`, values);
    await audit(req, 'UPDATE_INVENTORY', 'inventory', inventory.id, { fields: columns }, client);
    await client.query('COMMIT');
    res.json({ item: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

for (const [name, spec] of Object.entries(config)) {
  router.get(`/${name}`, roles.configure, async (_req, res, next) => {
    try {
      if (name === 'rates') {
        const rates = await pool.query(`SELECT rate.*,count(element.id)::int assigned_space_count
          FROM parking_rate_rules rate
          LEFT JOIN parking_layout_elements element ON element.rate_plan_id=rate.id
            AND EXISTS (SELECT 1 FROM parking_lot_layouts layout WHERE layout.id=element.layout_id AND layout.status IN ('DRAFT','PUBLISHED'))
          GROUP BY rate.id ORDER BY rate.id DESC`);
        return res.json({ items: rates.rows });
      }
      res.json({ items: (await pool.query(`SELECT * FROM ${spec.table} ORDER BY id DESC`)).rows });
    }
    catch (error) { next(error); }
  });
  router.post(`/${name}`, csrf, roles.configure, async (req, res, next) => {
    if (name === 'closures') return next();
    try {
      const columns = spec.columns.filter(key => req.body[key] !== undefined);
      if (!columns.length) throw apiError('VALIDATION_ERROR', 'Provide configuration fields');
      if (name === 'rates') {
        const client = await pool.connect();
        try {
          const candidate = { active: true, fee_cents: 0, tax_basis_points: 0, priority: 0, ...req.body };
          validateRate(candidate);
          await client.query('BEGIN');
          await rejectAmbiguousActiveRate(client, candidate);
          const created = await client.query(`INSERT INTO ${spec.table}(${columns.join(',')})
            VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')}) RETURNING *`, columns.map(key => req.body[key]));
          await audit(req, 'CREATE', name, created.rows[0].id, {}, client);
          await client.query('COMMIT');
          return res.status(201).json({ item: created.rows[0] });
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const created = await client.query(`INSERT INTO ${spec.table}(${columns.join(',')})
          VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')}) RETURNING *`, columns.map(key => req.body[key]));
        await audit(req, 'CREATE', name, created.rows[0].id, {}, client);
        await client.query('COMMIT');
        res.status(201).json({ item: created.rows[0] });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    } catch (error) { next(error); }
  });
  if (name === 'inventory') continue;
  router.patch(`/${name}/:id`, csrf, roles.configure, async (req, res, next) => {
    try {
      const currentVersion = version(req.body);
      const columns = spec.columns.filter(key => req.body[key] !== undefined);
      if (!columns.length) throw apiError('VALIDATION_ERROR', 'Provide configuration fields');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (name === 'locations') {
          const inventory = await client.query(`SELECT inventory.id FROM parking_inventory inventory
            JOIN parking_zones zone ON zone.id=inventory.zone_id WHERE zone.location_id=$1 ORDER BY inventory.id`, [req.params.id]);
          await lockInventoryIds(client, inventory.rows.map(row => row.id));
        }
        const current = await client.query(`SELECT * FROM ${spec.table} WHERE id=$1 FOR UPDATE`, [req.params.id]);
        if (!current.rowCount) throw apiError('NOT_FOUND', 'Configuration item not found', 404);
        if (Number(current.rows[0].version) !== currentVersion) throw apiError('BOOKING_VERSION_CONFLICT', 'Configuration changed; refresh and try again', 409);
        const candidate = { ...current.rows[0], ...Object.fromEntries(columns.map(key => [key, req.body[key]])) };
        if (name === 'rates') {
          validateRate(candidate);
          await rejectAmbiguousActiveRate(client, candidate, { exceptId: req.params.id });
        }
        if (name === 'closures') validateClosure(candidate);
        if (name === 'locations' && !['ZONE_CAPACITY', 'EXACT_SPOT'].includes(candidate.assignment_mode)) {
          throw apiError('VALIDATION_ERROR', 'Choose Highlight parking area or Assign exact numbered space');
        }
        if (name === 'locations' && columns.includes('assignment_mode')) {
          await rejectCanonicalExactAssignment(client, req.params.id, req.body.assignment_mode);
        }
        if (name === 'zones' && req.body.location_id !== undefined && Number(req.body.location_id) !== Number(current.rows[0].location_id)) {
          await guardZoneReassignment(client, req.params.id, req.body.location_id);
        }
        const values = columns.map(key => req.body[key]);
        values.push(req.params.id, currentVersion);
        const assignmentModeIndex = name === 'locations' ? columns.indexOf('assignment_mode') : -1;
        const assignmentReset = assignmentModeIndex >= 0
          ? `,exact_mode_active=CASE WHEN $${assignmentModeIndex + 1}::text IS DISTINCT FROM assignment_mode THEN false ELSE exact_mode_active END,
            physical_layout_confirmed_at=CASE WHEN $${assignmentModeIndex + 1}::text IS DISTINCT FROM assignment_mode THEN NULL ELSE physical_layout_confirmed_at END,
            physical_layout_confirmed_by_admin_user_id=CASE WHEN $${assignmentModeIndex + 1}::text IS DISTINCT FROM assignment_mode THEN NULL ELSE physical_layout_confirmed_by_admin_user_id END`
          : '';
        const updated = await client.query(`UPDATE ${spec.table} SET ${columns.map((key, index) => `${key}=$${index + 1}`).join(',')}${assignmentReset},
          version=version+1 WHERE id=$${columns.length + 1} AND version=$${columns.length + 2} RETURNING *`, values);
        await audit(req, 'UPDATE', name, req.params.id, { fields: columns }, client);
        await client.query('COMMIT');
        if (name === 'closures') {
          const affected = await affectedBookings(pool, updated.rows[0]);
          return res.json({ item: updated.rows[0], affectedBookings: affected });
        }
        res.json({ item: updated.rows[0] });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    } catch (error) { next(error); }
  });
}

module.exports = router;
