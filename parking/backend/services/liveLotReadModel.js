const { apiError } = require('../utils');
const { areaCapacityMetrics } = require('./parkingService');

const BLOCKING_BOOKING_STATUSES = ['CONFIRMED', 'CHECKED_IN'];
const MAX_TIMELINE_DAYS = 90;
const MAX_SNAPSHOT_DAYS = 366;

function iso(value, label, { maxDays = MAX_SNAPSHOT_DAYS } = {}) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  const text = String(value);
  if (!/(Z|[+-]\d\d:\d\d)$/.test(text)) throw apiError('OPERATIONAL_TIME_OFFSET_REQUIRED', `${label} must include a UTC offset`, 422);
  const instant = new Date(text);
  if (Number.isNaN(instant.getTime())) throw apiError('VALIDATION_ERROR', `${label} must be a valid timestamp`);
  if (Math.abs(instant.getTime() - Date.now()) > maxDays * 86400000) throw apiError('OPERATIONAL_TIME_OUT_OF_RANGE', `${label} must be within ${maxDays} days of now`, 422);
  return instant.toISOString();
}

function operationalStatus({ active, block, booking }) {
  if (!active) return 'INACTIVE';
  if (block) return 'BLOCKED';
  if (booking?.status === 'CHECKED_IN') return 'OCCUPIED';
  if (booking?.status === 'CONFIRMED') return 'RESERVED';
  return 'AVAILABLE';
}

function isAvailableCustomerSpace(space) {
  return Boolean(space?.active && space?.publicBookable === true && space?.operationalStatus === 'AVAILABLE' && space?.parkingPurpose === 'CUSTOMER'
    && (space?.dailyEligible || space?.monthlyEligible)
    && space?.ratePlan?.active && space?.classificationState === 'COMPLETE'
    && Array.isArray(space?.vehicleEligibility) && space.vehicleEligibility.length);
}

function warning(code, severity, message, extra = {}) { return { code, severity, message, ...extra }; }
function parkingUseLabel(row) {
  if (row.parking_use === 'CUSTOMER' && row.category_code === 'TRACTOR_TRAILER') return 'General Truck Parking';
  if (row.parking_use === 'CUSTOMER_BOBTAIL') return 'Bobtail Parking';
  if (row.parking_use === 'SHOP' || row.parking_use === 'SHOP_BOBTAIL') return 'Shop (internal)';
  if (row.parking_use === 'COMPANY') return 'Company (internal)';
  if (row.parking_use === 'INTERNAL') return 'Internal';
  return String(row.parking_use || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function compactReservation(row, { customer = false } = {}) {
  if (!row?.booking_id) return null;
  const snapshot = row.current_booking_snapshot && typeof row.current_booking_snapshot === 'object' ? row.current_booking_snapshot : null;
  return {
    id: Number(row.booking_id), reservationNumber: row.reservation_number, status: row.booking_status,
    startsAt: row.arrival_at, endsAt: row.departure_at,
    duration: snapshot?.duration || row.parking_product || null,
    assignmentMode: row.assignment_mode_snapshot || null,
    paymentStatus: row.payment_status || null,
    ...(customer ? { customer: {
      publicId: row.current_customer_public_id || null,
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unknown customer',
      companyName: row.company_name || null
    }, vehicle: {
      unitNumber: row.tractor_unit_number || null,
      licensePlate: row.license_plate || null,
      licensePlateState: row.license_plate_state || null
    }, rateCents: Number(snapshot?.totalCents || 0) } : {})
  };
}

async function publishedLayout(client, locationId) {
  const layout = (await client.query(`SELECT id,name,version,published_at FROM parking_lot_layouts
    WHERE location_id=$1 AND status='PUBLISHED'`, [locationId])).rows[0] || null;
  if (!layout) return { layout: null, elements: [] };
  const elements = await client.query(`SELECT id,element_type,label,parking_spot_id,x,y,width,height,rotation,layer_order,active,public_visible
    FROM parking_layout_elements WHERE layout_id=$1 ORDER BY layer_order,id`, [layout.id]);
  return { layout, elements: elements.rows };
}

async function snapshot(client, locationId, evaluatedAt, filters = {}) {
  const location = (await client.query(`SELECT id,name,timezone,active,assignment_mode,exact_mode_active
    FROM parking_locations WHERE id=$1`, [locationId])).rows[0];
  if (!location) throw apiError('NOT_FOUND', 'Parking lot not found', 404);
  const map = await publishedLayout(client, locationId);
  const areaCapacity = await areaCapacityMetrics(client, { locationId, at: evaluatedAt });
  const rows = await client.query(`SELECT s.id,s.public_label,s.display_order,s.active,s.internal_notes,s.physical_section,s.parking_use,s.public_bookable,s.classification_state,s.operational_label,s.zone_id,s.inventory_id,
      z.name area_name,z.public_visible zone_public_visible,z.active zone_active,
      i.active inventory_active,c.id category_id,c.code category_code,c.name category_name,c.active category_active,
      e.id element_id,e.element_type,e.x,e.y,e.width,e.height,e.rotation,e.layer_order,e.active element_active,e.parking_purpose,
      e.daily_eligible,e.weekly_eligible,e.monthly_eligible,e.space_public_bookable,COALESCE(e.rate_plan_id,rate.id) rate_plan_id,
      rate.plan_name rate_plan_name,rate.active rate_plan_active,rate.starts_at rate_plan_starts_at,rate.ends_at rate_plan_ends_at,
      rate.daily_rate_cents rate_plan_daily_rate_cents,rate.weekly_rate_cents rate_plan_weekly_rate_cents,
      rate.monthly_rate_cents rate_plan_monthly_rate_cents,
      block.id block_id,block.starts_at block_starts_at,block.ends_at block_ends_at,block.reason block_reason,block.internal_note block_note,
      current_assignment.id assignment_id,current_assignment.assigned_at, current_assignment.actual_check_in_at,current_assignment.actual_check_out_at,
      current_booking.id booking_id,current_booking.reservation_number,current_booking.status booking_status,current_booking.payment_status,current_booking.parking_product,current_booking.arrival_at,current_booking.departure_at,
      current_booking.first_name,current_booking.last_name,current_booking.company_name,current_booking.assignment_mode_snapshot,
      current_booking.tractor_unit_number,current_booking.license_plate,current_booking.license_plate_state,
      current_customer.public_id current_customer_public_id,
      current_snapshot.snapshot current_booking_snapshot,
      next_assignment.id next_assignment_id,next_booking.id next_booking_id,next_booking.reservation_number next_reservation_number,
      next_booking.status next_booking_status,next_booking.arrival_at next_arrival_at,next_booking.departure_at next_departure_at
    FROM parking_spots s
    LEFT JOIN parking_zones z ON z.id=s.zone_id
    LEFT JOIN parking_inventory i ON i.id=s.inventory_id
    LEFT JOIN parking_categories c ON c.id=i.category_id
    LEFT JOIN parking_layout_elements e ON e.layout_id=$3 AND e.parking_spot_id=s.id
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM parking_rate_rules candidate
      WHERE candidate.location_id=s.location_id AND candidate.category_id=i.category_id
        AND (candidate.zone_id IS NULL OR candidate.zone_id=s.zone_id)
        AND (e.rate_plan_id IS NULL OR candidate.id=e.rate_plan_id)
      ORDER BY (e.rate_plan_id IS NOT NULL) DESC,candidate.active DESC,
        (candidate.starts_at IS NULL OR candidate.starts_at<=$2) DESC,
        (candidate.ends_at IS NULL OR candidate.ends_at>$2) DESC,
        (candidate.zone_id IS NOT NULL) DESC,candidate.priority DESC,candidate.id DESC LIMIT 1
    ) rate ON true
    LEFT JOIN LATERAL (SELECT b.* FROM parking_spot_blocks b WHERE b.parking_spot_id=s.id AND b.released_at IS NULL
      AND b.starts_at<=$2 AND COALESCE(b.ends_at,'infinity'::timestamptz)>$2 ORDER BY b.starts_at DESC,b.id DESC LIMIT 1) block ON true
    LEFT JOIN LATERAL (SELECT a.* FROM reservation_spot_assignments a JOIN parking_bookings b ON b.id=a.booking_id
      WHERE a.parking_spot_id=s.id AND a.released_at IS NULL AND b.status=ANY($4::text[])
        AND (b.status='CHECKED_IN'
          OR (a.reserved_arrival_at<=$2 AND a.protected_until_at>$2)
          OR (b.status='CONFIRMED' AND b.payment_status IN ('PAID','NOT_REQUIRED','DEMO_BYPASSED')
            AND a.reserved_arrival_at>$2))
      ORDER BY CASE WHEN b.status='CHECKED_IN' THEN 0
        WHEN a.reserved_arrival_at<=$2 AND a.protected_until_at>$2 THEN 1 ELSE 2 END,
        a.assigned_at DESC,a.id DESC LIMIT 1) current_assignment ON true
    LEFT JOIN parking_bookings current_booking ON current_booking.id=current_assignment.booking_id
    LEFT JOIN parking_customers current_customer ON current_customer.id=current_booking.customer_id
    LEFT JOIN parking_booking_price_snapshots current_snapshot ON current_snapshot.booking_id=current_booking.id
    LEFT JOIN LATERAL (SELECT a.* FROM reservation_spot_assignments a JOIN parking_bookings b ON b.id=a.booking_id
      WHERE a.parking_spot_id=s.id AND a.released_at IS NULL AND b.status='CONFIRMED' AND a.reserved_arrival_at>$2
      ORDER BY a.reserved_arrival_at,a.id LIMIT 1) next_assignment ON true
    LEFT JOIN parking_bookings next_booking ON next_booking.id=next_assignment.booking_id
    WHERE s.location_id=$1 AND (s.active OR e.id IS NOT NULL)
    ORDER BY z.display_order,z.name,s.display_order,s.public_label,s.id`,
  [locationId, evaluatedAt, map.layout?.id || null, BLOCKING_BOOKING_STATUSES]);

  const globalWarnings = [];
  if (!map.layout) globalWarnings.push(warning('NO_PUBLISHED_LAYOUT', 'WARNING', 'This lot has no published map.', { locationId: Number(locationId) }));
  for (const area of areaCapacity) if (area.shortfall > 0) globalWarnings.push(warning('AREA_CAPACITY_SHORTFALL', 'ERROR',
    `${area.area} has ${area.shortfall} more active commitments than usable physical positions.`, {
      inventoryId: area.inventoryId, area: area.area, reserved: area.reservedCapacity + area.checkedInCapacity,
      usablePhysicalCapacity: area.usablePhysical, shortfall: area.shortfall
    }));
  const spaces = rows.rows.map(row => {
    const current = compactReservation(row, { customer: true });
    const next = row.next_booking_id ? { id: Number(row.next_booking_id), reservationNumber: row.next_reservation_number,
      status: row.next_booking_status, startsAt: row.next_arrival_at, endsAt: row.next_departure_at } : null;
    const activeBlock = row.block_id ? { id: Number(row.block_id), startsAt: row.block_starts_at, endsAt: row.block_ends_at,
      reason: row.block_reason } : null;
    const rowWarnings = [];
    if (row.active && map.layout && !row.element_id) rowWarnings.push(warning('SPACE_MISSING_PUBLISHED_LAYOUT_ELEMENT', 'WARNING', `Active space ${row.public_label} is not present in the published layout.`, { spaceId: Number(row.id) }));
    if (!row.zone_id || !row.area_name) rowWarnings.push(warning('SPACE_MISSING_AREA', 'ERROR', `Space ${row.public_label} has no parking area.`, { spaceId: Number(row.id) }));
    if (!row.inventory_id || !row.category_id || !row.inventory_active || !row.category_active) rowWarnings.push(warning('SPACE_NO_ACTIVE_VEHICLE_ELIGIBILITY', 'WARNING', `Space ${row.public_label} has no active vehicle eligibility.`, { spaceId: Number(row.id) }));
    if (row.classification_state === 'NEEDS_CLASSIFICATION') rowWarnings.push(warning('NEEDS_CLASSIFICATION', 'WARNING', `Space ${row.public_label} requires owner classification and is not automatically assignable.`, { spaceId: Number(row.id) }));
    const ratePlanEffective = Boolean(row.rate_plan_id && row.rate_plan_active
      && (!row.rate_plan_starts_at || new Date(row.rate_plan_starts_at) <= new Date(evaluatedAt))
      && (!row.rate_plan_ends_at || new Date(row.rate_plan_ends_at) > new Date(evaluatedAt)));
    if ((row.daily_eligible || row.weekly_eligible || row.monthly_eligible) && !ratePlanEffective) rowWarnings.push(warning('RATE_PLAN_UNAVAILABLE', 'WARNING', `Space ${row.public_label} has enabled booking products without an effective rate plan.`, { spaceId: Number(row.id) }));
    if (row.daily_eligible && row.rate_plan_daily_rate_cents == null) rowWarnings.push(warning('DAILY_RATE_REQUIRED', 'WARNING', `Space ${row.public_label} enables Daily parking without a daily price.`, { spaceId: Number(row.id) }));
    if (row.monthly_eligible && row.rate_plan_monthly_rate_cents == null) rowWarnings.push(warning('MONTHLY_RATE_REQUIRED', 'WARNING', `Space ${row.public_label} enables Monthly parking without a monthly price.`, { spaceId: Number(row.id) }));
    if (activeBlock && next) rowWarnings.push(warning('BLOCKED_FUTURE_RESERVATION', 'WARNING', `Space ${row.public_label} is blocked now and has a future reservation.`, { spaceId: Number(row.id), blockId: Number(row.block_id), reservationId: Number(row.next_booking_id) }));
    if (row.booking_status === 'CHECKED_IN' && new Date(row.departure_at) < new Date(evaluatedAt)) rowWarnings.push(warning('ASSIGNMENT_PAST_EXPECTED_DEPARTURE', 'WARNING', `Space ${row.public_label} remains checked in past its expected departure.`, { spaceId: Number(row.id), reservationId: Number(row.booking_id) }));
    return {
      id: Number(row.id), number: row.public_label, active: Boolean(row.active),
      area: row.zone_id ? { id: Number(row.zone_id), name: row.parking_purpose === 'CUSTOMER' ? 'General Area' : 'Operations' } : null,
      physicalSection: row.physical_section,
      operationalStatus: operationalStatus({ active: row.active, block: activeBlock, booking: current }),
      parkingUse: row.parking_use,
      parkingUseLabel: parkingUseLabel(row),
      classificationState: row.classification_state,
      operationalLabel: row.operational_label,
      parkingPurpose: row.parking_purpose || (['CUSTOMER','CUSTOMER_BOBTAIL','DAILY','WEEKLY','MONTHLY'].includes(row.parking_use) ? 'CUSTOMER' : row.parking_use === 'COMPANY' ? 'COMPANY' : row.parking_use?.startsWith('SHOP') ? 'SHOP' : 'UNRESOLVED'),
      dailyEligible: Boolean(row.daily_eligible),
      weeklyEligible: Boolean(row.weekly_eligible),
      monthlyEligible: Boolean(row.monthly_eligible),
      bookingTerm: row.daily_eligible && !row.monthly_eligible ? 'DAILY' : row.monthly_eligible && !row.daily_eligible ? 'MONTHLY' : null,
      accessType: row.parking_purpose === 'CUSTOMER' ? 'CUSTOMER' : row.parking_purpose || 'INTERNAL',
      vehicleType: row.category_code === 'BOBTAIL' ? 'BOBTAIL' : 'GENERAL',
      publicBookable: Boolean(row.parking_purpose === null ? row.public_bookable : row.space_public_bookable),
      ratePlan: row.rate_plan_id ? {
        id: Number(row.rate_plan_id), name: row.rate_plan_name || 'Parking rate plan', active: ratePlanEffective,
        dailyRateCents: row.rate_plan_daily_rate_cents == null ? null : Number(row.rate_plan_daily_rate_cents),
        monthlyRateCents: row.rate_plan_monthly_rate_cents == null ? null : Number(row.rate_plan_monthly_rate_cents),
        dailyPriceConfigured: row.rate_plan_daily_rate_cents != null,
        weeklyPriceConfigured: row.rate_plan_weekly_rate_cents != null,
        monthlyPriceConfigured: row.rate_plan_monthly_rate_cents != null,
        status: ratePlanEffective ? 'ACTIVE' : 'INACTIVE'
      } : null,
      bookingVisibility: Boolean(row.parking_purpose === null ? row.public_bookable : row.space_public_bookable) && (row.parking_purpose || (['CUSTOMER','CUSTOMER_BOBTAIL','DAILY','WEEKLY','MONTHLY'].includes(row.parking_use) ? 'CUSTOMER' : 'UNRESOLVED')) === 'CUSTOMER' && row.zone_public_visible && row.inventory_active && row.category_active ? 'PUBLIC' : 'INTERNAL_ONLY',
      vehicleEligibility: row.category_id && row.category_active ? [{ id: Number(row.category_id), code: row.category_code, name: row.category_code === 'TRACTOR_TRAILER' && row.parking_use === 'CUSTOMER' ? 'General Truck Parking' : row.category_name }] : [],
      currentReservation: current, currentAssignment: row.assignment_id ? { id: Number(row.assignment_id), assignedAt: row.assigned_at,
        actualCheckInAt: row.actual_check_in_at, actualCheckOutAt: row.actual_check_out_at } : null,
      nextReservation: next, activeBlock,
      layout: row.element_id ? { elementId: Number(row.element_id), x: Number(row.x), y: Number(row.y), width: Number(row.width),
        height: Number(row.height), rotation: Number(row.rotation), shape: 'RECTANGLE', zOrder: Number(row.layer_order) } : null,
      warnings: rowWarnings
    };
  });
  const statusFilter = filters.operationalStatus ? String(filters.operationalStatus).toUpperCase() : null;
  if (statusFilter && !['AVAILABLE','RESERVED','OCCUPIED','BLOCKED','INACTIVE'].includes(statusFilter)) throw apiError('VALIDATION_ERROR', 'Operational status filter is invalid');
  const filtered = spaces.filter(space => (!filters.vehicleCategoryId || space.vehicleEligibility.some(item => item.id === Number(filters.vehicleCategoryId)))
    && (!statusFilter || space.operationalStatus === statusFilter) && (!filters.parkingUse || space.parkingUse === String(filters.parkingUse).toUpperCase())
    && (!filters.availableOnly || isAvailableCustomerSpace(space))
    && (!filters.search || `${space.number} ${space.area?.name || ''}`.toLowerCase().includes(String(filters.search).trim().toLowerCase())));
  const summary = { physicalSpaces: filtered.length, customerSpaces: 0, availableCustomerSpaces: 0, dailyAvailable: 0,
    monthlyAvailable: 0, dailyPhysical: 0, monthlyPhysical: 0, publiclyBookable: 0, generalTruck: 0, bobtail: 0,
    internalUse: 0, unresolved: 0, reserved: 0, occupied: 0, blocked: 0, inactive: 0, configurationIssues: 0 };
  filtered.forEach(space => {
    if (isAvailableCustomerSpace(space)) summary.availableCustomerSpaces += 1;
    if (space.parkingPurpose === 'CUSTOMER' && space.active) summary.customerSpaces += 1;
    if (space.parkingPurpose === 'CUSTOMER' && space.active && space.dailyEligible) summary.dailyPhysical += 1;
    if (space.parkingPurpose === 'CUSTOMER' && space.active && space.monthlyEligible) summary.monthlyPhysical += 1;
    if (space.parkingPurpose === 'CUSTOMER' && space.active && space.monthlyEligible && space.operationalStatus === 'AVAILABLE') summary.monthlyAvailable += 1;
    if (space.publicBookable && space.classificationState === 'COMPLETE') summary.publiclyBookable += 1;
    if (space.parkingUse === 'CUSTOMER') summary.generalTruck += 1;
    if (space.parkingUse === 'CUSTOMER_BOBTAIL') summary.bobtail += 1;
    if (['SHOP', 'SHOP_BOBTAIL', 'COMPANY', 'INTERNAL'].includes(space.parkingUse)) summary.internalUse += 1;
    if (space.classificationState === 'NEEDS_CLASSIFICATION') summary.unresolved += 1;
    if (['RESERVED', 'OCCUPIED', 'BLOCKED'].includes(space.operationalStatus)) summary[space.operationalStatus.toLowerCase()] += 1;
    if (space.operationalStatus === 'INACTIVE') summary.inactive += 1;
    summary.configurationIssues += space.warnings.filter(item => item.severity !== 'INFO').length;
  });
  const dailyCommitments = await client.query(`SELECT category.code,count(*)::int count
    FROM parking_bookings booking JOIN parking_categories category ON category.id=booking.category_id
    WHERE booking.location_id=$1 AND booking.parking_product='DAILY' AND booking.status=ANY($3::text[])
      AND (CASE WHEN booking.status='CHECKED_IN' THEN COALESCE(booking.actual_arrival_at,booking.arrival_at) ELSE booking.arrival_at END)<=$2
      AND (CASE WHEN booking.status='CHECKED_IN' AND booking.actual_departure_at IS NULL THEN true
        WHEN booking.status='CHECKED_IN' THEN booking.actual_departure_at>$2 ELSE COALESCE(booking.departure_at,'infinity'::timestamptz)>$2 END)
    GROUP BY category.code`, [locationId,evaluatedAt,BLOCKING_BOOKING_STATUSES]);
  const dailyByVehicle = new Map(dailyCommitments.rows.map(row => [row.code,Number(row.count)]));
  const dailyGroups = ['TRACTOR_TRAILER','BOBTAIL'].map(code => {
    const eligible = filtered.filter(space => space.parkingPurpose === 'CUSTOMER' && space.active && space.dailyEligible
      && space.vehicleEligibility.some(item => item.code === code));
    const usable = eligible.filter(space => space.operationalStatus !== 'BLOCKED' && space.operationalStatus !== 'INACTIVE').length;
    const committed = dailyByVehicle.get(code) || 0;
    return { vehicleType: code === 'BOBTAIL' ? 'BOBTAIL' : 'GENERAL', physical: eligible.length, usable,
      committed, available: Math.max(0,usable-committed) };
  }).filter(group => group.physical > 0 || group.committed > 0);
  summary.dailyAvailable = dailyGroups.reduce((total,group) => total+group.available,0);
  const mapElements = map.elements.map(element => ({ id: Number(element.id), type: element.element_type, label: element.label,
    spaceId: element.parking_spot_id ? Number(element.parking_spot_id) : null, x: Number(element.x), y: Number(element.y), width: Number(element.width),
    height: Number(element.height), rotation: Number(element.rotation), shape: 'RECTANGLE', zOrder: Number(element.layer_order), active: Boolean(element.active) }));
  return { location: { id: Number(location.id), name: location.name, timezone: location.timezone, publishedLayoutId: map.layout ? Number(map.layout.id) : null,
    layoutVersion: map.layout ? Number(map.layout.version) : null }, requestedAt: evaluatedAt, evaluatedAt, summary, spaces: filtered,
    areaCapacity, productAvailability: { daily: dailyGroups,
      monthly: ['GENERAL','BOBTAIL'].map(type => { const items=filtered.filter(space => space.parkingPurpose === 'CUSTOMER'
        && space.active && space.monthlyEligible && space.vehicleType === type); return { vehicleType:type,physical:items.length,
        available:items.filter(space => space.operationalStatus === 'AVAILABLE').length }; }).filter(group => group.physical>0) },
    layout: map.layout ? { id: Number(map.layout.id), name: map.layout.name, version: Number(map.layout.version), publishedAt: map.layout.published_at, elements: mapElements } : null,
    warnings: globalWarnings.concat(filtered.flatMap(space => space.warnings)) };
}

function mergeIntervals(intervals, from, to) {
  const points = [...new Set([from, to, ...intervals.flatMap(item => [item.startsAt, item.endsAt])].map(value => new Date(value).toISOString()))].sort();
  const priority = { BLOCKED: 3, OCCUPIED: 2, RESERVED: 1 };
  const result = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const startsAt = points[index], endsAt = points[index + 1];
    if (startsAt === endsAt) continue;
    const active = intervals.filter(item => new Date(item.startsAt) <= new Date(startsAt) && new Date(item.endsAt) >= new Date(endsAt))
      .sort((a, b) => priority[b.type] - priority[a.type]);
    const chosen = active[0] || { type: 'AVAILABLE' };
    const item = { ...chosen, startsAt, endsAt };
    const previous = result[result.length - 1];
    if (previous && previous.type === item.type && previous.reservationId === item.reservationId && previous.blockId === item.blockId && previous.endsAt === item.startsAt) previous.endsAt = item.endsAt;
    else result.push(item);
  }
  return result;
}

async function timeline(client, spaceId, from, to) {
  const space = (await client.query(`SELECT s.id,s.public_label,s.location_id,l.timezone FROM parking_spots s JOIN parking_locations l ON l.id=s.location_id WHERE s.id=$1`, [spaceId])).rows[0];
  if (!space) throw apiError('NOT_FOUND', 'Numbered space not found', 404);
  const [assignments, blocks] = await Promise.all([
    client.query(`SELECT a.id assignment_id,b.id booking_id,b.reservation_number,b.status,b.arrival_at,b.departure_at,b.first_name,b.last_name,
        a.reserved_arrival_at,a.protected_until_at,a.actual_check_in_at,a.actual_check_out_at
      FROM reservation_spot_assignments a JOIN parking_bookings b ON b.id=a.booking_id
      WHERE a.parking_spot_id=$1 AND a.released_at IS NULL AND b.status=ANY($2::text[])
        AND (CASE WHEN b.status='CHECKED_IN' THEN COALESCE(a.actual_check_in_at,a.reserved_arrival_at) ELSE a.reserved_arrival_at END)<$4
        AND COALESCE(a.actual_check_out_at,a.protected_until_at)>$3 ORDER BY a.reserved_arrival_at,a.id`, [spaceId, BLOCKING_BOOKING_STATUSES, from, to]),
    client.query(`SELECT id,starts_at,ends_at,reason FROM parking_spot_blocks WHERE parking_spot_id=$1 AND released_at IS NULL
      AND starts_at<$3 AND COALESCE(ends_at,$3::timestamptz)>$2 ORDER BY starts_at,id`, [spaceId, from, to])
  ]);
  const intervals = [
    ...assignments.rows.map(row => ({ type: row.status === 'CHECKED_IN' ? 'OCCUPIED' : 'RESERVED', reservationId: Number(row.booking_id), assignmentId: Number(row.assignment_id),
      startsAt: new Date(Math.max(new Date(from), new Date(row.status === 'CHECKED_IN' ? row.actual_check_in_at || row.reserved_arrival_at : row.reserved_arrival_at))).toISOString(),
      endsAt: new Date(Math.min(new Date(to), new Date(row.actual_check_out_at || row.protected_until_at))).toISOString(),
      customer: { name: `${row.first_name} ${row.last_name}`.trim() }, reservationNumber: row.reservation_number })),
    ...blocks.rows.map(row => ({ type: 'BLOCKED', blockId: Number(row.id), reason: row.reason,
      startsAt: new Date(Math.max(new Date(from), new Date(row.starts_at))).toISOString(), endsAt: new Date(Math.min(new Date(to), new Date(row.ends_at || to))).toISOString(), openEnded: !row.ends_at }))
  ];
  const warnings = [];
  for (let i = 1; i < intervals.length; i += 1) if (new Date(intervals[i].startsAt) < new Date(intervals[i - 1].endsAt)) warnings.push(warning('TIMELINE_OVERLAP', 'WARNING', 'Overlapping operational intervals were resolved by status precedence.', { spaceId: Number(spaceId) }));
  return { space: { id: Number(space.id), number: space.public_label, locationId: Number(space.location_id), timezone: space.timezone }, from, to,
    intervalConvention: '[start,end)', intervals: mergeIntervals(intervals, from, to), warnings };
}

async function detail(client, spaceId, evaluatedAt, role) {
  const found = await client.query('SELECT location_id FROM parking_spots WHERE id=$1', [spaceId]);
  if (!found.rowCount) throw apiError('NOT_FOUND', 'Numbered space not found', 404);
  const model = await snapshot(client, found.rows[0].location_id, evaluatedAt);
  const space = model.spaces.find(item => item.id === Number(spaceId));
  const [history, notes] = await Promise.all([
    client.query(`SELECT a.id,a.assigned_at,a.released_at,a.release_reason,a.assignment_source,a.assignment_reason,b.id booking_id,b.reservation_number,b.status
      FROM reservation_spot_assignments a JOIN parking_bookings b ON b.id=a.booking_id WHERE a.parking_spot_id=$1 ORDER BY a.assigned_at DESC,a.id DESC LIMIT 20`, [spaceId]),
    space.currentReservation ? client.query(`SELECT visibility,note,created_at FROM parking_booking_notes WHERE booking_id=$1
      AND visibility='INTERNAL' ORDER BY created_at DESC LIMIT 10`, [space.currentReservation.id]) : Promise.resolve({ rows: [] })
  ]);
  const current = space.currentReservation ? (await client.query(`SELECT booking.first_name,booking.last_name,booking.mobile_phone,booking.email,booking.company_name,
      booking.usdot_number,booking.tractor_unit_number,booking.trailer_number,booking.license_plate,booking.license_plate_state,
      booking.payment_status,customer.public_id customer_public_id,customer.display_name,customer.company_name customer_company_name,
      customer.display_phone,customer.display_email,customer.usdot_number customer_usdot_number,customer.mc_number,
      (price.snapshot->>'totalCents')::integer current_rate_cents,billing.status billing_status,billing.balance_cents
    FROM parking_bookings booking
    LEFT JOIN parking_customers customer ON customer.id=booking.customer_id
    LEFT JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
    LEFT JOIN LATERAL (
      SELECT aggregate.*,
        GREATEST(aggregate.amount_due_cents-aggregate.paid_cents,0)::bigint balance_cents,
        CASE WHEN aggregate.amount_due_cents=0 THEN 'NOT_DUE'
          WHEN aggregate.paid_cents>=aggregate.amount_due_cents THEN 'PAID'
          WHEN aggregate.paid_cents>0 THEN 'PARTIAL'
          WHEN aggregate.due_date<current_date THEN 'OVERDUE' ELSE 'DUE' END status
      FROM (SELECT balance.period_start,sum(balance.amount_due_cents)::bigint amount_due_cents,
          sum(balance.paid_cents)::bigint paid_cents,min(balance.due_date) due_date
        FROM parking_customer_billing_period_balances balance WHERE balance.customer_id=customer.id
        GROUP BY balance.period_start) aggregate
      ORDER BY (aggregate.period_start=date_trunc('month',current_date)::date) DESC,aggregate.period_start DESC LIMIT 1
    ) billing ON true
    WHERE booking.id=$1`, [space.currentReservation.id])).rows[0] : null;
  return { ...space, evaluatedAt, currentCustomer: current ? {
      publicId: current.customer_public_id,
      name: current.display_name || `${current.first_name} ${current.last_name}`.trim(),
      phone: current.display_phone || current.mobile_phone,
      email: current.display_email || current.email,
      company: current.customer_company_name || current.company_name,
      usdotNumber: current.customer_usdot_number || current.usdot_number,
      mcNumber: current.mc_number,
      rateCents: current.current_rate_cents == null ? null : Number(current.current_rate_cents),
      payment: { status: current.billing_status || current.payment_status || 'NOT_DUE',
        balanceCents: current.balance_cents == null ? null : Number(current.balance_cents) }
    } : null,
    currentVehicle: current ? { unitNumber: current.tractor_unit_number, trailerNumber: current.trailer_number, licensePlate: current.license_plate, licensePlateState: current.license_plate_state,
      category: space.vehicleEligibility[0] || null } : null, notes: notes.rows.map(row => ({ visibility: row.visibility, note: row.note, createdAt: row.created_at })),
    recentHistory: history.rows.map(row => ({ assignmentId: Number(row.id), reservationId: Number(row.booking_id), reservationNumber: row.reservation_number, status: row.status,
      assignedAt: row.assigned_at, releasedAt: row.released_at, source: row.assignment_source, reason: row.release_reason || row.assignment_reason })),
    actions: { canReserve: space.operationalStatus === 'AVAILABLE', canCheckIn: space.currentReservation?.status === 'CONFIRMED', canExtend: false,
      canMove: Boolean(space.currentAssignment), canCheckOut: space.currentReservation?.status === 'CHECKED_IN', canBlock: role === 'OWNER' && space.operationalStatus === 'AVAILABLE',
      canUnblock: role === 'OWNER' && Boolean(space.activeBlock), canEditLayout: role === 'OWNER' }
  };
}

function escapeLike(value) { return String(value).replace(/[\\%_]/g, character => `\\${character}`); }
async function search(client, locationId, query, limit = 20) {
  const term = String(query || '').trim();
  if (term.length < 2) throw apiError('SEARCH_QUERY_TOO_SHORT', 'Search for at least two characters');
  const pattern = `%${escapeLike(term)}%`; const phonePattern = `%${escapeLike(term.replace(/\D/g, ''))}%`; const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const [spaces, reservations, customers, vehicles] = await Promise.all([
    client.query(`SELECT id,public_label FROM parking_spots WHERE location_id=$1 AND active AND public_label ILIKE $2 ESCAPE '\\' ORDER BY public_label,id LIMIT $3`, [locationId, pattern, capped]),
    client.query(`SELECT id,reservation_number,status,arrival_at,departure_at,assigned_spot_label FROM parking_bookings WHERE location_id=$1 AND
      (reservation_number ILIKE $2 ESCAPE '\\' OR first_name ILIKE $2 ESCAPE '\\' OR last_name ILIKE $2 ESCAPE '\\' OR mobile_phone ILIKE $2 ESCAPE '\\' OR regexp_replace(mobile_phone,'\\D','','g') ILIKE $3 ESCAPE '\\' OR email ILIKE $2 ESCAPE '\\' OR company_name ILIKE $2 ESCAPE '\\')
      ORDER BY updated_at DESC,id DESC LIMIT $4`, [locationId, pattern, phonePattern, capped]),
    client.query(`SELECT DISTINCT ON (lower(email)) first_name,last_name,email,mobile_phone,company_name FROM parking_bookings WHERE location_id=$1 AND
      (first_name ILIKE $2 ESCAPE '\\' OR last_name ILIKE $2 ESCAPE '\\' OR mobile_phone ILIKE $2 ESCAPE '\\' OR regexp_replace(mobile_phone,'\\D','','g') ILIKE $3 ESCAPE '\\' OR email ILIKE $2 ESCAPE '\\' OR company_name ILIKE $2 ESCAPE '\\')
      ORDER BY lower(email),updated_at DESC LIMIT $4`, [locationId, pattern, phonePattern, capped]),
    client.query(`SELECT id,reservation_number,tractor_unit_number,trailer_number,license_plate,license_plate_state,assigned_spot_label FROM parking_bookings WHERE location_id=$1 AND
      (tractor_unit_number ILIKE $2 ESCAPE '\\' OR trailer_number ILIKE $2 ESCAPE '\\' OR license_plate ILIKE $2 ESCAPE '\\') ORDER BY updated_at DESC,id DESC LIMIT $3`, [locationId, pattern, capped])
  ]);
  return { locationId: Number(locationId), query: term, spaces: spaces.rows.map(row => ({ id: Number(row.id), number: row.public_label })),
    reservations: reservations.rows.map(row => ({ id: Number(row.id), reservationNumber: row.reservation_number, status: row.status, arrival: row.arrival_at, departure: row.departure_at, space: row.assigned_spot_label })),
    customers: customers.rows.map(row => ({ name: `${row.first_name} ${row.last_name}`.trim(), email: row.email, phone: row.mobile_phone, company: row.company_name })),
    vehicles: vehicles.rows.map(row => ({ reservationId: Number(row.id), reservationNumber: row.reservation_number, unitNumber: row.tractor_unit_number, trailerNumber: row.trailer_number, licensePlate: row.license_plate, licensePlateState: row.license_plate_state, space: row.assigned_spot_label })) };
}

module.exports = { MAX_TIMELINE_DAYS, iso, operationalStatus, isAvailableCustomerSpace, mergeIntervals, snapshot, detail, timeline, search };
