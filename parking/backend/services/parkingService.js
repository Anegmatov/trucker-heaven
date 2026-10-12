const { apiError, interval } = require('../utils');
const { DateTime } = require('luxon');
const { capacityBlockingStatuses } = require('./bookingWorkflow');
const { durationFor, unitsFor, monthlyOccupancyEnd } = require('./bookingPolicy');
const { SUPPORTED_PUBLIC_DURATIONS } = require('./publicParkingProducts');
const { nextWeeklyBillingAt } = require('./weeklyParking');

async function lockInventoryIds(client, inventoryIds) {
  const ids = [...new Set(inventoryIds.filter(value => value !== null && value !== undefined).map(Number))].sort((a, b) => a - b);
  for (const id of ids) await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [id]);
  return ids;
}
async function inventoryFor(client, { locationId, zoneId, categoryCode, arrival, departure, lock = false }) {
  const { start, end } = interval(arrival, departure);
  const query = `SELECT i.id inventory_id, i.capacity, i.public_remaining_capacity, i.public_description, i.restrictions,
      z.id zone_id, z.public_id zone_public_id,z.name zone_name, z.public_visible,z.arrival_directions,z.exit_directions,
      l.id location_id, l.name location_name, l.timezone,
      l.assignment_mode, l.exact_mode_active, l.turnaround_buffer_minutes,
      EXISTS(SELECT 1 FROM parking_lot_layouts published
        WHERE published.location_id=l.id AND published.status='PUBLISHED') has_published_layout,
      c.id category_id, c.code category_code,
      CASE WHEN c.code='BOBTAIL' AND EXISTS (SELECT 1 FROM parking_lot_layouts canonical
        WHERE canonical.location_id=l.id AND canonical.status='PUBLISHED' AND canonical.name LIKE 'Trucker Heaven physical lot ·%')
        THEN 'Bobtail'
        WHEN c.code='TRACTOR_TRAILER' AND EXISTS (SELECT 1 FROM parking_lot_layouts canonical
          WHERE canonical.location_id=l.id AND canonical.status='PUBLISHED' AND canonical.name LIKE 'Trucker Heaven physical lot ·%')
        THEN 'General Truck Parking' ELSE c.name END category_name
    FROM parking_inventory i JOIN parking_zones z ON z.id=i.zone_id JOIN parking_locations l ON l.id=z.location_id
    JOIN parking_categories c ON c.id=i.category_id
    WHERE l.id=$1 AND ($2::bigint IS NULL OR z.id=$2) AND l.active AND z.active AND z.public_visible
      AND i.active AND c.active AND c.code=$3
    ORDER BY i.id`;
  const { rows } = await client.query(query, [locationId, zoneId, categoryCode]);
  return { rows, start, end };
}
async function availability(client, input, { lock = false, excludeBookingId = null } = {}) {
  let { rows, start, end } = await inventoryFor(client, input);
  if (!rows.length) return [];
  const ids = rows.map(row => row.inventory_id);
  // Inventory IDs are unique 64-bit primary keys, so this one-key advisory lock has no cross-inventory collisions.
  if (lock) {
    await lockInventoryIds(client, ids);
    // Capacity/configuration edits use the same key. Reload after locking so a
    // booking cannot make its final decision from inventory read before an edit.
    ({ rows, start, end } = await inventoryFor(client, input));
    if (!rows.length) return [];
  }
  // Customer assignment behavior is an immutable property of the selected
  // parking term. Daily sells one highlighted-area capacity unit. Monthly
  // requires a physical position explicitly selected by the customer.
  if (input.customerAssignmentMode) {
    rows = rows.map(row => ({ ...row, assignment_mode: input.customerAssignmentMode, exact_mode_active: false }));
  }
  // Capacity is evaluated at every event boundary that can increase load during
  // the requested half-open interval. For a published physical lot, eligible
  // layout spaces are the authoritative base and timed physical blocks consume
  // capacity alongside every overlapping reservation (legacy exact and area).
  // Locations without a published physical layout retain their legacy static
  // inventory capacity behavior.
  // These values are validated against the workflow's finite status enum at
  // process start, so embedding them avoids an ambiguous PostgreSQL array bind.
  const blockingStatusSql = capacityBlockingStatuses().map(status => `'${status}'`).join(', ') || 'NULL';
  // A booking that holds parking at point p.point and overlaps the requested interval.
  const activeAtPoint = `b.inventory_id=p.inventory_id AND b.status IN (${blockingStatusSql})
          AND ($5::bigint IS NULL OR b.id<>$5)
          AND (CASE WHEN b.status='CHECKED_IN' THEN COALESCE(b.actual_arrival_at,b.arrival_at) ELSE b.arrival_at END)<=p.point
          AND (CASE WHEN b.status='CHECKED_IN' AND b.actual_departure_at IS NULL THEN true
          WHEN b.status='CHECKED_IN' THEN b.actual_departure_at>p.point ELSE COALESCE(b.departure_at,'infinity'::timestamptz)>p.point END)
          AND (CASE WHEN b.status='CHECKED_IN' THEN COALESCE(b.actual_arrival_at,b.arrival_at) ELSE b.arrival_at END)<$3
          AND (CASE WHEN b.status='CHECKED_IN' AND b.actual_departure_at IS NULL THEN true
          WHEN b.status='CHECKED_IN' THEN b.actual_departure_at>$2 ELSE COALESCE(b.departure_at,'infinity'::timestamptz)>$2 END)`;
  const occupied = await client.query(`WITH inventory_scope AS (
      SELECT i.id inventory_id,z.id zone_id,z.location_id,i.category_id
      FROM parking_inventory i JOIN parking_zones z ON z.id=i.zone_id WHERE i.id=ANY($1::bigint[])
    ), eligible_spots AS (
      SELECT element.inventory_id,spot.id parking_spot_id
      FROM parking_lot_layouts layout
      JOIN parking_layout_elements element ON element.layout_id=layout.id
      JOIN parking_spots spot ON spot.id=element.parking_spot_id
      JOIN parking_inventory inventory ON inventory.id=element.inventory_id
      LEFT JOIN parking_rate_rules plan ON plan.id=element.rate_plan_id
        AND plan.active AND plan.location_id=spot.location_id AND plan.category_id=inventory.category_id
        AND (plan.zone_id IS NULL OR plan.zone_id=spot.zone_id)
        AND (plan.starts_at IS NULL OR plan.starts_at<=$2)
        AND (plan.ends_at IS NULL OR plan.ends_at>$2)
      WHERE layout.status='PUBLISHED' AND element.inventory_id=ANY($1::bigint[])
        AND element.element_type='PARKING_SPOT' AND element.active AND element.public_visible
        AND element.parking_purpose='CUSTOMER' AND element.space_public_bookable
        AND spot.active AND spot.public_bookable AND spot.classification_state='COMPLETE'
        AND (($4='DAILY' AND element.daily_eligible) OR ($4='WEEKLY' AND element.weekly_eligible)
          OR ($4='MONTHLY' AND element.monthly_eligible))
        AND plan.id IS NOT NULL
        AND (($4='DAILY' AND plan.daily_rate_cents IS NOT NULL)
          OR ($4='WEEKLY' AND plan.weekly_rate_cents IS NOT NULL)
          OR ($4='MONTHLY' AND plan.monthly_rate_cents IS NOT NULL))
    ), points AS (
      SELECT inventory_id,zone_id,location_id,category_id,$2::timestamptz AS point FROM inventory_scope
      UNION
      SELECT s.inventory_id,s.zone_id,s.location_id,s.category_id,
        CASE WHEN b.status='CHECKED_IN' THEN COALESCE(b.actual_arrival_at,b.arrival_at) ELSE b.arrival_at END
      FROM inventory_scope s JOIN parking_bookings b ON b.inventory_id=s.inventory_id
      WHERE b.status IN (${blockingStatusSql})
        AND ($5::bigint IS NULL OR b.id<>$5)
        AND CASE WHEN b.status='CHECKED_IN' THEN COALESCE(b.actual_arrival_at,b.arrival_at) ELSE b.arrival_at END >= $2
        AND CASE WHEN b.status='CHECKED_IN' THEN COALESCE(b.actual_arrival_at,b.arrival_at) ELSE b.arrival_at END < $3
      UNION
      SELECT s.inventory_id,s.zone_id,s.location_id,s.category_id,c.starts_at
      FROM inventory_scope s JOIN parking_closures c ON (c.location_id=s.location_id OR c.zone_id=s.zone_id OR c.inventory_id=s.inventory_id OR c.category_id=s.category_id)
      WHERE c.active AND c.starts_at >= $2 AND c.starts_at < $3
      UNION
      SELECT s.inventory_id,s.zone_id,s.location_id,s.category_id,block.starts_at
      FROM inventory_scope s JOIN eligible_spots eligible ON eligible.inventory_id=s.inventory_id
      JOIN parking_spot_blocks block ON block.parking_spot_id=eligible.parking_spot_id
      WHERE block.released_at IS NULL AND block.starts_at >= $2 AND block.starts_at < $3
    ), measured AS (
      SELECT p.inventory_id,
        (SELECT count(*)::int FROM parking_bookings b WHERE ${activeAtPoint}) commitments,
        (SELECT count(*)::int FROM parking_bookings b WHERE ${activeAtPoint}
          AND b.assignment_mode_snapshot='ZONE_CAPACITY') area_commitments,
        (SELECT count(DISTINCT eligible.parking_spot_id)::int FROM eligible_spots eligible
          JOIN parking_spot_blocks block ON block.parking_spot_id=eligible.parking_spot_id
          WHERE eligible.inventory_id=p.inventory_id AND block.released_at IS NULL
            AND block.starts_at<=p.point AND COALESCE(block.ends_at,'infinity'::timestamptz)>p.point) blocked_capacity,
        (SELECT COALESCE(sum(c.capacity_reduction) FILTER (WHERE c.closure_type='CAPACITY_REDUCTION'),0)::int FROM parking_closures c WHERE c.active AND c.starts_at<=p.point AND c.ends_at>p.point AND (c.location_id=p.location_id OR c.zone_id=p.zone_id OR c.inventory_id=p.inventory_id OR c.category_id=p.category_id)) closure_reduction,
        EXISTS(SELECT 1 FROM parking_closures c WHERE c.active AND c.closure_type='FULL_CLOSURE' AND c.starts_at<=p.point AND c.ends_at>p.point AND (c.location_id=p.location_id OR c.zone_id=p.zone_id OR c.inventory_id=p.inventory_id OR c.category_id=p.category_id)) closed
      FROM points p
    ), physical AS (
      SELECT inventory_id,count(*)::int physical_capacity FROM eligible_spots GROUP BY inventory_id
    ) SELECT measured.inventory_id,COALESCE(physical.physical_capacity,0)::int physical_capacity,
      MAX(measured.commitments+measured.blocked_capacity+measured.closure_reduction)::int used,
      MAX(measured.commitments)::int commitments,MAX(measured.area_commitments)::int area_commitments,
      MAX(measured.blocked_capacity)::int blocked_capacity,
      MAX(measured.closure_reduction)::int closure_reduction,BOOL_OR(measured.closed) closed
    FROM measured LEFT JOIN physical USING(inventory_id)
    GROUP BY measured.inventory_id,physical.physical_capacity`, [ids, start, end,
    input.duration || durationFor(start, end, rows[0].timezone), excludeBookingId]);
  const peakByInventory = new Map(occupied.rows.map(r => [Number(r.inventory_id), r]));
  const exactIds = rows.filter(row => row.assignment_mode === 'CUSTOMER_SELECTED_SPOT'
    || (row.assignment_mode === 'EXACT_SPOT' && row.exact_mode_active)).map(row => row.inventory_id);
  const exactByInventory = new Map();
  if (exactIds.length) {
    const requestedDuration = input.duration || durationFor(start, end, rows[0].timezone);
    // Per spot: can it be sold for this term (term_ok), could an area booking park there (area_ok),
    // and is it free for the whole requested window (free)?
    const exact = await client.query(`WITH spaces AS (
      SELECT element.inventory_id,
        ((($4='DAILY' AND element.daily_eligible) OR ($4='WEEKLY' AND element.weekly_eligible)
            OR ($4='MONTHLY' AND element.monthly_eligible))
          AND ((element.rate_plan_id IS NOT NULL AND configured_plan.id IS NOT NULL
              AND (($4='DAILY' AND configured_plan.daily_rate_cents IS NOT NULL)
                OR ($4='WEEKLY' AND configured_plan.weekly_rate_cents IS NOT NULL)
                OR ($4='MONTHLY' AND configured_plan.monthly_rate_cents IS NOT NULL)))
            OR (element.rate_plan_id IS NULL AND EXISTS (
              SELECT 1 FROM parking_rate_rules fallback
              WHERE fallback.active AND fallback.location_id=s.location_id
                AND fallback.category_id=configured_inventory.category_id
                AND (fallback.zone_id IS NULL OR fallback.zone_id=s.zone_id)
                AND (fallback.starts_at IS NULL OR fallback.starts_at<=$2)
                AND (fallback.ends_at IS NULL OR fallback.ends_at>$2)
                AND (($4='DAILY' AND fallback.daily_rate_cents IS NOT NULL)
                  OR ($4='WEEKLY' AND fallback.weekly_rate_cents IS NOT NULL)
                  OR ($4='MONTHLY' AND fallback.monthly_rate_cents IS NOT NULL)))))) term_ok,
        (element.daily_eligible OR element.weekly_eligible) area_ok,
        (NOT EXISTS (SELECT 1 FROM parking_spot_blocks block
            WHERE block.parking_spot_id=s.id AND block.released_at IS NULL
              AND block.starts_at<($3::timestamptz + make_interval(mins=>l.turnaround_buffer_minutes))
              AND COALESCE(block.ends_at,'infinity'::timestamptz)>$2)
          AND NOT EXISTS (SELECT 1 FROM reservation_spot_assignments a
            JOIN parking_bookings booking ON booking.id=a.booking_id
            WHERE a.parking_spot_id=s.id AND a.released_at IS NULL
              AND booking.status IN ('CONFIRMED','CHECKED_IN')
              AND ($5::bigint IS NULL OR a.booking_id<>$5)
              AND a.reserved_arrival_at<($3::timestamptz + make_interval(mins=>l.turnaround_buffer_minutes))
              AND a.protected_until_at>$2)) free
      FROM parking_spots s
      JOIN parking_locations l ON l.id=s.location_id
      JOIN parking_lot_layouts layout ON layout.location_id=s.location_id AND layout.status='PUBLISHED'
      JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.parking_spot_id=s.id
        AND element.element_type='PARKING_SPOT' AND element.active AND element.public_visible
      JOIN parking_inventory configured_inventory ON configured_inventory.id=element.inventory_id
      LEFT JOIN parking_rate_rules configured_plan ON configured_plan.id=element.rate_plan_id AND configured_plan.active
        AND configured_plan.location_id=s.location_id AND configured_plan.category_id=configured_inventory.category_id
        AND (configured_plan.zone_id IS NULL OR configured_plan.zone_id=s.zone_id)
        AND (configured_plan.starts_at IS NULL OR configured_plan.starts_at<=$2)
        AND (configured_plan.ends_at IS NULL OR configured_plan.ends_at>$2)
      WHERE element.inventory_id=ANY($1::bigint[]) AND s.active
        AND element.space_public_bookable AND element.parking_purpose='CUSTOMER'
        AND s.classification_state='COMPLETE'
    ) SELECT inventory_id,
        count(*) FILTER (WHERE term_ok)::int effective_capacity,
        count(*) FILTER (WHERE term_ok AND free)::int available_count,
        count(*) FILTER (WHERE NOT term_ok AND area_ok AND free)::int area_only_free
      FROM spaces GROUP BY inventory_id`, [exactIds, start, end, requestedDuration, excludeBookingId]);
    exact.rows.forEach(item => exactByInventory.set(Number(item.inventory_id), item));
  }
  return rows.map(row => {
    const exactMode = row.assignment_mode === 'CUSTOMER_SELECTED_SPOT'
      || (row.assignment_mode === 'EXACT_SPOT' && row.exact_mode_active);
    if (exactMode) {
      const exact = exactByInventory.get(Number(row.inventory_id)) || { effective_capacity: 0, available_count: 0 };
      const peak = peakByInventory.get(Number(row.inventory_id)) || { closed: false, closure_reduction: 0 };
      // Exact-space availability is based on actual eligible, published spots.
      // Capacity closures still apply: a full closure prevents every assignment,
      // and a reduction reserves that many otherwise-free eligible spots. Area
      // bookings (staff-entered, no numbered space) also need somewhere to park:
      // free spaces this term can't sell take them first, the rest are held back.
      const areaOverflow = Math.max(0, Number(peak.area_commitments || 0) - Number(exact.area_only_free || 0));
      const reserved = Number(peak.closure_reduction || 0) + areaOverflow;
      const availableSpots = peak.closed ? 0 : Math.max(0, Number(exact.available_count) - reserved);
      return { ...row, requested_duration: input.duration, assignment_mode: row.assignment_mode, effective_capacity: Number(exact.effective_capacity),
        used: Number(exact.effective_capacity) - availableSpots, closed: Boolean(peak.closed), start, end,
        available: availableSpots > 0, available_spots: availableSpots };
    }
    const peak = peakByInventory.get(Number(row.inventory_id)) || { used: 0, commitments: 0, blocked_capacity: 0, closed: false, physical_capacity: 0 };
    const effectiveCapacity = row.has_published_layout ? Number(peak.physical_capacity) : Number(row.capacity);
    return { ...row, requested_duration: input.duration, assignment_mode: 'ZONE_CAPACITY', effective_capacity: effectiveCapacity,
      physical_capacity: row.has_published_layout ? Number(peak.physical_capacity) : null,
      used: Number(peak.used), commitments: Number(peak.commitments), blocked_capacity: Number(peak.blocked_capacity),
      closed: Boolean(peak.closed), start, end, available: !peak.closed && effectiveCapacity > Number(peak.used) };
  });
}

// The finalization path is the only point at which an unpaid attempt becomes
// operational. It serializes against every competing booking for the selected
// inventory and re-evaluates availability from committed reservations.
async function assertFinalBookingAvailability(client, booking) {
  const inventory = (await client.query(`SELECT inventory.id inventory_id,zone.id zone_id,category.code category_code
    FROM parking_inventory inventory
    JOIN parking_zones zone ON zone.id=inventory.zone_id
    JOIN parking_categories category ON category.id=inventory.category_id
    WHERE inventory.id=$1 AND zone.location_id=$2 AND category.id=$3`, [
    booking.inventory_id, booking.location_id, booking.category_id
  ])).rows[0];
  if (!inventory) throw apiError('PARKING_ALLOCATION_UNAVAILABLE', 'The selected parking area is no longer available', 409);
  const departure = booking.departure_at || (['WEEKLY', 'MONTHLY'].includes(booking.parking_product) ? monthlyOccupancyEnd() : null);
  if (!departure) throw apiError('PARKING_ALLOCATION_UNAVAILABLE', 'The reservation interval is incomplete', 409);
  const slots = await availability(client, {
    locationId: booking.location_id,
    zoneId: inventory.zone_id,
    categoryCode: inventory.category_code,
    arrival: booking.arrival_at,
    departure,
    duration: booking.parking_product,
    customerAssignmentMode: booking.assignment_mode_snapshot
  }, { lock: true, excludeBookingId: booking.id });
  const slot = slots.find(item => Number(item.inventory_id) === Number(booking.inventory_id) && item.available);
  if (!slot) throw apiError('PARKING_ALLOCATION_UNAVAILABLE', 'Parking is no longer available for this reservation', 409);
  return slot;
}

async function areaCapacityMetrics(client, { locationId = null, at = new Date().toISOString() } = {}) {
  const blockingStatusSql = capacityBlockingStatuses().map(status => `'${status}'`).join(', ') || 'NULL';
  const result = await client.query(`WITH scope AS (
      SELECT inventory.id inventory_id,inventory.capacity configured_capacity,inventory.category_id,
        zone.id zone_id,zone.name area_name,zone.location_id,location.name location_name,
        location.assignment_mode,category.code category_code,
        CASE WHEN category.code='BOBTAIL' THEN 'Bobtail Parking'
          WHEN category.code='TRACTOR_TRAILER' THEN 'General Truck Parking' ELSE category.name END public_area_name,
        EXISTS(SELECT 1 FROM parking_lot_layouts layout
          WHERE layout.location_id=location.id AND layout.status='PUBLISHED') has_published_layout
      FROM parking_inventory inventory
      JOIN parking_zones zone ON zone.id=inventory.zone_id
      JOIN parking_locations location ON location.id=zone.location_id
      JOIN parking_categories category ON category.id=inventory.category_id
      WHERE ($1::bigint IS NULL OR location.id=$1) AND inventory.active AND zone.active AND location.active AND category.active
    ), eligible AS (
      SELECT element.inventory_id,spot.id parking_spot_id
      FROM scope
      JOIN parking_lot_layouts layout ON layout.location_id=scope.location_id AND layout.status='PUBLISHED'
      JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.inventory_id=scope.inventory_id
      JOIN parking_spots spot ON spot.id=element.parking_spot_id
      LEFT JOIN parking_rate_rules plan ON plan.id=element.rate_plan_id AND plan.active
        AND plan.location_id=scope.location_id AND plan.category_id=scope.category_id
        AND (plan.zone_id IS NULL OR plan.zone_id=scope.zone_id)
        AND (plan.starts_at IS NULL OR plan.starts_at<=$2) AND (plan.ends_at IS NULL OR plan.ends_at>$2)
      WHERE element.element_type='PARKING_SPOT' AND element.active AND element.public_visible
        AND element.parking_purpose='CUSTOMER' AND element.space_public_bookable
        AND spot.active AND spot.public_bookable AND spot.classification_state='COMPLETE'
        AND (element.daily_eligible OR element.weekly_eligible OR element.monthly_eligible)
        AND plan.id IS NOT NULL
        AND ((element.daily_eligible AND plan.daily_rate_cents IS NOT NULL)
          OR (element.weekly_eligible AND plan.weekly_rate_cents IS NOT NULL)
          OR (element.monthly_eligible AND plan.monthly_rate_cents IS NOT NULL))
    ), physical AS (
      SELECT inventory_id,count(*)::int physical_capacity FROM eligible GROUP BY inventory_id
    ), blocked AS (
      SELECT eligible.inventory_id,count(DISTINCT eligible.parking_spot_id)::int blocked_physical
      FROM eligible JOIN parking_spot_blocks block ON block.parking_spot_id=eligible.parking_spot_id
      WHERE block.released_at IS NULL AND block.starts_at<=$2
        AND COALESCE(block.ends_at,'infinity'::timestamptz)>$2
      GROUP BY eligible.inventory_id
    ), commitments AS (
      SELECT booking.inventory_id,
        count(*) FILTER (WHERE booking.status='CONFIRMED')::int reserved_capacity,
        count(*) FILTER (WHERE booking.status='CHECKED_IN')::int checked_in_capacity,
        count(*) FILTER (WHERE booking.assignment_mode_snapshot='EXACT_SPOT')::int exact_capacity,
        count(*) FILTER (WHERE booking.assignment_mode_snapshot='CUSTOMER_SELECTED_SPOT')::int customer_selected_capacity,
        count(*) FILTER (WHERE booking.assignment_mode_snapshot='ZONE_CAPACITY')::int area_capacity
      FROM parking_bookings booking
      WHERE booking.status IN (${blockingStatusSql})
        AND (CASE WHEN booking.status='CHECKED_IN' THEN COALESCE(booking.actual_arrival_at,booking.arrival_at) ELSE booking.arrival_at END)<=$2
        AND (CASE WHEN booking.status='CHECKED_IN' AND booking.actual_departure_at IS NULL THEN true
          WHEN booking.status='CHECKED_IN' THEN booking.actual_departure_at>$2 ELSE COALESCE(booking.departure_at,'infinity'::timestamptz)>$2 END)
      GROUP BY booking.inventory_id
    ), closures AS (
      SELECT scope.inventory_id,
        COALESCE(sum(closure.capacity_reduction) FILTER (WHERE closure.closure_type='CAPACITY_REDUCTION'),0)::int closure_reduction,
        COALESCE(bool_or(closure.closure_type='FULL_CLOSURE'),false) closed
      FROM scope LEFT JOIN parking_closures closure ON closure.active AND closure.starts_at<=$2 AND closure.ends_at>$2
        AND (closure.location_id=scope.location_id OR closure.zone_id=scope.zone_id
          OR closure.inventory_id=scope.inventory_id OR closure.category_id=scope.category_id)
      GROUP BY scope.inventory_id
    ) SELECT scope.*,
      CASE WHEN scope.has_published_layout THEN COALESCE(physical.physical_capacity,0) ELSE scope.configured_capacity END::int physical_capacity,
      COALESCE(blocked.blocked_physical,0)::int blocked_physical,
      COALESCE(commitments.reserved_capacity,0)::int reserved_capacity,
      COALESCE(commitments.checked_in_capacity,0)::int checked_in_capacity,
      COALESCE(commitments.exact_capacity,0)::int exact_capacity,
      COALESCE(commitments.customer_selected_capacity,0)::int customer_selected_capacity,
      COALESCE(commitments.area_capacity,0)::int area_capacity,
      COALESCE(closures.closure_reduction,0)::int closure_reduction,COALESCE(closures.closed,false) closed
    FROM scope LEFT JOIN physical USING(inventory_id) LEFT JOIN blocked USING(inventory_id)
    LEFT JOIN commitments USING(inventory_id) LEFT JOIN closures USING(inventory_id)
    ORDER BY scope.location_name,scope.area_name,scope.public_area_name,scope.inventory_id`, [locationId, at]);
  return result.rows.map(row => {
    const physicalCapacity = Number(row.physical_capacity);
    const blockedPhysical = Number(row.blocked_physical);
    const closureReduction = Number(row.closure_reduction);
    const reservedCapacity = Number(row.reserved_capacity);
    const checkedInCapacity = Number(row.checked_in_capacity);
    const committed = reservedCapacity + checkedInCapacity;
    const usablePhysical = row.closed ? 0 : Math.max(0, physicalCapacity - blockedPhysical - closureReduction);
    return {
      inventoryId: Number(row.inventory_id), locationId: Number(row.location_id), location: row.location_name,
      areaId: Number(row.zone_id), area: row.public_area_name, configuredArea: row.area_name,
      categoryCode: row.category_code, assignmentMode: row.assignment_mode,
      physicalCapacity, blockedPhysical, closureReduction, usablePhysical,
      reservedCapacity, checkedInCapacity, exactCapacity: Number(row.exact_capacity),
      customerSelectedCapacity: Number(row.customer_selected_capacity), areaCapacity: Number(row.area_capacity),
      availableCapacity: Math.max(0, usablePhysical - committed), shortfall: Math.max(0, committed - usablePhysical),
      closed: Boolean(row.closed), evaluatedAt: at
    };
  }).filter(item => item.physicalCapacity > 0 || item.reservedCapacity > 0 || item.checkedInCapacity > 0);
}
function safeMoney(value, label) {
  const amount = BigInt(value || 0);
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw apiError('INVALID_PRICE_CONFIGURATION', `${label} is outside the supported range`, 409);
  return amount;
}

function monthlyInitialCents(unitRateCents, arrival, timezone = 'UTC') {
  const start = DateTime.fromISO(arrival, { zone: 'utc' }).setZone(timezone);
  if (!start.isValid) throw apiError('INVALID_BOOKING_INTERVAL', 'Monthly parking requires a valid start date', 422);
  const occupiedDays = start.daysInMonth - start.day + 1;
  return Number((BigInt(unitRateCents) * BigInt(occupiedDays) + BigInt(Math.floor(start.daysInMonth / 2))) / BigInt(start.daysInMonth));
}

async function priceQuote(client, input, inventory, { rateRuleId = null } = {}) {
  const duration = input.duration || durationFor(input.arrival, input.departure, inventory.timezone);
  const openEndedWeekly = duration === 'WEEKLY' && input.openEnded === true;
  const units = openEndedWeekly ? 1 : unitsFor(input.arrival, input.departure, duration, inventory.timezone);
  const offer = await rateOffer(client, input, inventory, duration, { rateRuleId });
  if (!offer.rule) throw apiError('RATE_NOT_CONFIGURED', 'A rate is not configured for this parking selection', 409);
  if (offer.unitRateCents == null) throw apiError('RATE_NOT_CONFIGURED', 'A rate is not configured for this duration', 409);
  const rule = offer.rule;
  const unitRate = safeMoney(offer.unitRateCents, 'Unit rate');
  const monthlyStart = duration === 'MONTHLY'
    ? DateTime.fromISO(input.arrival, { zone: 'utc' }).setZone(inventory.timezone || 'UTC') : null;
  const occupiedDays = monthlyStart ? monthlyStart.daysInMonth - monthlyStart.day + 1 : null;
  const base = monthlyStart
    ? BigInt(monthlyInitialCents(Number(unitRate), input.arrival, inventory.timezone || 'UTC'))
    : unitRate * BigInt(units);
  const fee = safeMoney(rule.fee_cents, 'Fee');
  const taxable = base + fee;
  const tax = (taxable * safeMoney(rule.tax_basis_points, 'Tax basis points') + 5000n) / 10000n;
  const discount = safeMoney(input.discountCents, 'Discount');
  const total = base + fee + tax - discount;
  if (total < 0n) throw apiError('VALIDATION_ERROR', 'Discount cannot exceed total');
  const number = value => Number(value);
  return { duration, units, currency: 'USD', ratePlanName: offer.planName, unitRateCents: number(unitRate), baseParkingCents: number(base), feesCents: number(fee), taxCents: number(tax), discountCents: number(discount), manualAdjustmentCents: 0, totalCents: number(total), rateRuleId: rule.id, rateRuleVersion: Number(rule.version), paymentMode: 'PAY_AT_LOCATION', ...(monthlyStart ? { openEnded: true, initialProrated: monthlyStart.day !== 1, initialOccupiedDays: occupiedDays, initialMonthDays: monthlyStart.daysInMonth, nextBillingAt: monthlyStart.plus({ months: 1 }).startOf('month').toUTC().toISO(), recurringUnitRateCents: number(unitRate) } : {}), ...(openEndedWeekly ? { openEnded: true, nextBillingAt: nextWeeklyBillingAt(input.arrival), recurringUnitRateCents: number(unitRate) } : {}) };
}

// A public rate offer intentionally contains only display-safe pricing data.
// The selected rule ID stays server-side, while the same reusable rule remains
// the single source for the availability card, quote, and booking snapshot.
async function rateOffer(client, input, inventory, requestedDuration = null, { rateRuleId = null } = {}) {
  const rate = rateRuleId == null
    ? await client.query(`SELECT * FROM parking_rate_rules WHERE active AND location_id=$1 AND category_id=$2
        AND (zone_id IS NULL OR zone_id=$3) AND (starts_at IS NULL OR starts_at <= $4) AND (ends_at IS NULL OR ends_at > $4)
        ORDER BY (starts_at IS NOT NULL) DESC, (zone_id IS NOT NULL) DESC, priority DESC, id DESC LIMIT 1`,
        [input.locationId, inventory.category_id, inventory.zone_id, inventory.start])
    : await client.query(`SELECT * FROM parking_rate_rules WHERE id=$1 AND active AND location_id=$2 AND category_id=$3
        AND (zone_id IS NULL OR zone_id=$4) AND (starts_at IS NULL OR starts_at <= $5) AND (ends_at IS NULL OR ends_at > $5)`,
        [rateRuleId, input.locationId, inventory.category_id, inventory.zone_id, inventory.start]);
  if (!rate.rowCount) return { rule: null, planName: null, durations: [], unitRateCents: null };
  const rule = rate.rows[0];
  const rateByDuration = { DAILY: rule.daily_rate_cents, WEEKLY: rule.weekly_rate_cents, MONTHLY: rule.monthly_rate_cents };
  const durations = SUPPORTED_PUBLIC_DURATIONS.map(code => [code, rateByDuration[code]])
    .filter(([, cents]) => cents != null).map(([code, cents]) => ({ code, unitRateCents: Number(cents) }));
  const priceByDuration = new Map(durations.map(item => [item.code, item.unitRateCents]));
  const planName = String(rule.plan_name || '').trim() || 'Parking rate plan';
  return {
    rule,
    planName,
    durations,
    unitRateCents: requestedDuration ? (priceByDuration.get(requestedDuration) ?? null) : null
  };
}

async function publicRateOfferForInventory(client, input, inventory) {
  if (inventory.assignment_mode === 'ZONE_CAPACITY') return rateOffer(client, input, inventory);
  const plans = await client.query(`SELECT rule.*,
      bool_or(element.daily_eligible) daily_eligible,
      bool_or(element.weekly_eligible) weekly_eligible,
      bool_or(element.monthly_eligible) monthly_eligible
    FROM parking_lot_layouts layout
    JOIN parking_layout_elements element ON element.layout_id=layout.id
    JOIN parking_spots spot ON spot.id=element.parking_spot_id AND spot.active AND spot.classification_state='COMPLETE'
    JOIN LATERAL (
      SELECT candidate.* FROM parking_rate_rules candidate
      WHERE candidate.active AND candidate.location_id=$1 AND candidate.category_id=$3
        AND (candidate.zone_id IS NULL OR candidate.zone_id=$4)
        AND (candidate.starts_at IS NULL OR candidate.starts_at<=$5)
        AND (candidate.ends_at IS NULL OR candidate.ends_at>$5)
        AND (element.rate_plan_id IS NULL OR candidate.id=element.rate_plan_id)
      ORDER BY (element.rate_plan_id IS NOT NULL) DESC,(candidate.starts_at IS NOT NULL) DESC,
        (candidate.zone_id IS NOT NULL) DESC,candidate.priority DESC,candidate.id DESC LIMIT 1
    ) rule ON true
    WHERE layout.location_id=$1 AND layout.status='PUBLISHED' AND element.inventory_id=$2
      AND element.active AND element.public_visible AND element.parking_purpose='CUSTOMER' AND element.space_public_bookable
    GROUP BY rule.id,rule.location_id,rule.zone_id,rule.category_id,rule.plan_name,rule.daily_rate_cents,
      rule.weekly_rate_cents,rule.monthly_rate_cents,rule.fee_cents,rule.tax_basis_points,rule.starts_at,
      rule.ends_at,rule.priority,rule.active,rule.version`,
  [input.locationId, inventory.inventory_id, inventory.category_id, inventory.zone_id, inventory.start]);
  if (!plans.rows.length) return { rule: null, planName: null, durations: [], unitRateCents: null };
  const choices = new Map();
  for (const rule of plans.rows) {
    for (const [code, cents, eligible] of [
      ['DAILY', rule.daily_rate_cents, rule.daily_eligible],
      ['WEEKLY', rule.weekly_rate_cents, rule.weekly_eligible],
      ['MONTHLY', rule.monthly_rate_cents, rule.monthly_eligible]
    ]) {
      if (!eligible || cents == null) continue;
      const current = choices.get(code);
      if (!current || Number(cents) < current.unitRateCents) choices.set(code, { code, unitRateCents: Number(cents), planName: String(rule.plan_name || '').trim() || 'Parking rate plan' });
    }
  }
  const durations = [...choices.values()].map(({ code, unitRateCents }) => ({ code, unitRateCents }));
  return { rule: plans.rows[0], planName: plans.rows.length > 1 ? 'Multiple parking rate plans' : (String(plans.rows[0].plan_name || '').trim() || 'Parking rate plan'), durations, unitRateCents: null };
}

module.exports = { availability, assertFinalBookingAvailability, areaCapacityMetrics, priceQuote, rateOffer, publicRateOfferForInventory, durationFor, unitsFor, monthlyInitialCents, lockInventoryIds };
