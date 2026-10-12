const { apiError } = require('../utils');
const { durationFor, monthlyOccupancyEnd } = require('./bookingPolicy');
const { lockInventoryIds } = require('./parkingService');

const BLOCKING_STATUSES = ['CONFIRMED', 'CHECKED_IN'];

function addMinutes(instant, minutes) {
  return new Date(new Date(instant).getTime() + Number(minutes || 0) * 60000).toISOString();
}
function bookingOccupancyEnd(booking) {
  return booking.parking_product === 'MONTHLY' && !booking.departure_at ? monthlyOccupancyEnd() : booking.departure_at;
}

async function expireQuoteHolds(client) {
  return client.query(`UPDATE parking_public_quotes
    SET hold_released_at=COALESCE(hold_released_at,now()),hold_status='EXPIRED'
    WHERE assignment_mode='CUSTOMER_SELECTED_SPOT'
      AND consumed_booking_id IS NULL
      AND hold_released_at IS NULL
      AND COALESCE(checkout_hold_expires_at,expires_at)<=now()`);
}

async function currentAssignment(client, bookingId, { lock = false } = {}) {
  const result = await client.query(`SELECT a.*,s.public_label,s.location_id,s.zone_id,s.inventory_id,z.name zone_name
    FROM reservation_spot_assignments a
    JOIN parking_spots s ON s.id=a.parking_spot_id
    JOIN parking_zones z ON z.id=s.zone_id
    WHERE a.booking_id=$1 AND a.released_at IS NULL
    ORDER BY a.id DESC LIMIT 1${lock ? ' FOR UPDATE OF a' : ''}`, [bookingId]);
  return result.rows[0] || null;
}

async function selectExactSpot(client, { slot, arrival, departure, preferredSpotId = null, excludeQuoteId = null, lock = true }) {
  const protectedUntil = addMinutes(departure, slot.turnaround_buffer_minutes);
  const duration = slot.requested_duration || durationFor(arrival, departure, slot.timezone || 'UTC');
  const candidate = await client.query(`SELECT s.*,e.rate_plan_id,plan.version rate_plan_version
    FROM parking_spots s
    JOIN parking_lot_layouts l ON l.location_id=s.location_id AND l.status='PUBLISHED'
    JOIN parking_layout_elements e ON e.layout_id=l.id AND e.parking_spot_id=s.id
      AND e.element_type='PARKING_SPOT' AND e.active AND e.public_visible
    JOIN parking_inventory inventory ON inventory.id=e.inventory_id
    LEFT JOIN parking_rate_rules plan ON plan.id=e.rate_plan_id AND plan.active
      AND plan.location_id=s.location_id AND plan.category_id=inventory.category_id
      AND (plan.zone_id IS NULL OR plan.zone_id=s.zone_id)
      AND (plan.starts_at IS NULL OR plan.starts_at<=$3) AND (plan.ends_at IS NULL OR plan.ends_at>$3)
    WHERE s.location_id=$1 AND e.inventory_id=$2 AND s.active AND e.space_public_bookable
      AND e.parking_purpose='CUSTOMER'
      AND (($5='DAILY' AND e.daily_eligible) OR ($5='WEEKLY' AND e.weekly_eligible) OR ($5='MONTHLY' AND e.monthly_eligible))
      AND s.classification_state='COMPLETE'
      AND ($6::bigint IS NULL OR s.id=$6)
      AND ((e.rate_plan_id IS NOT NULL AND plan.id IS NOT NULL
            AND (($5='DAILY' AND plan.daily_rate_cents IS NOT NULL)
              OR ($5='WEEKLY' AND plan.weekly_rate_cents IS NOT NULL)
              OR ($5='MONTHLY' AND plan.monthly_rate_cents IS NOT NULL)))
        OR (e.rate_plan_id IS NULL AND EXISTS (
          SELECT 1 FROM parking_rate_rules fallback
          WHERE fallback.active AND fallback.location_id=s.location_id
            AND fallback.category_id=inventory.category_id
            AND (fallback.zone_id IS NULL OR fallback.zone_id=s.zone_id)
            AND (fallback.starts_at IS NULL OR fallback.starts_at<=$3)
            AND (fallback.ends_at IS NULL OR fallback.ends_at>$3)
            AND (($5='DAILY' AND fallback.daily_rate_cents IS NOT NULL)
              OR ($5='WEEKLY' AND fallback.weekly_rate_cents IS NOT NULL)
              OR ($5='MONTHLY' AND fallback.monthly_rate_cents IS NOT NULL)))))
      AND NOT EXISTS (
        SELECT 1 FROM parking_spot_blocks block
        WHERE block.parking_spot_id=s.id AND block.released_at IS NULL
          AND block.starts_at<$4 AND COALESCE(block.ends_at,'infinity'::timestamptz)>$3
      )
      AND NOT EXISTS (
        SELECT 1 FROM reservation_spot_assignments a
        JOIN parking_bookings booking ON booking.id=a.booking_id
        WHERE a.parking_spot_id=s.id AND a.released_at IS NULL
          AND booking.status=ANY($7::text[])
          AND a.reserved_arrival_at<$4 AND a.protected_until_at>$3
      )
      AND NOT EXISTS (
        SELECT 1 FROM parking_closures c
        WHERE c.active AND c.closure_type='FULL_CLOSURE'
          AND c.starts_at<$4 AND c.ends_at>$3
          AND (c.location_id=s.location_id OR c.zone_id=s.zone_id OR c.inventory_id=s.inventory_id OR c.category_id=inventory.category_id)
      )
    ORDER BY s.display_order,s.public_label,s.id
    ${lock ? 'FOR UPDATE OF s SKIP LOCKED' : ''} LIMIT 1`, [slot.location_id, slot.inventory_id, arrival, protectedUntil, duration, preferredSpotId, BLOCKING_STATUSES]);
  if (!candidate.rowCount) {
    if (preferredSpotId !== null) {
      throw apiError('MONTHLY_POSITION_UNAVAILABLE', 'That parking space is no longer available. Choose another open space.', 409);
    }
    throw apiError('NO_EXACT_SPOT_AVAILABLE', 'No compatible numbered space remains for the requested time', 409);
  }
  return candidate.rows[0];
}

async function assignSelectedExactSpot(client, { booking, slot, spot, source = 'CUSTOMER_AUTO', adminUserId = null, reason = '' }) {
  const occupancyEnd = bookingOccupancyEnd(booking);
  const protectedUntil = addMinutes(occupancyEnd, slot.turnaround_buffer_minutes);
  const assignment = await client.query(`INSERT INTO reservation_spot_assignments(
      booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,
      assignment_source,assigned_by_admin_user_id,assignment_reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [booking.id, spot.id, booking.arrival_at,
    occupancyEnd, protectedUntil, source, adminUserId, reason]);
  await client.query('UPDATE parking_bookings SET assigned_zone_id=$1,assigned_spot_label=$2 WHERE id=$3',
    [spot.zone_id, spot.public_label, booking.id]);
  return { ...assignment.rows[0], public_label: spot.public_label, zone_id: spot.zone_id };
}

async function assignExactSpot(client, options) {
  const spot = options.spot || await selectExactSpot(client, {
    slot: options.slot,
    arrival: options.booking.arrival_at,
    departure: bookingOccupancyEnd(options.booking),
    preferredSpotId: options.preferredSpotId
  });
  return assignSelectedExactSpot(client, { ...options, spot });
}

async function releaseCurrentAssignment(client, bookingId, reason) {
  const released = await client.query(`UPDATE reservation_spot_assignments
    SET released_at=COALESCE(released_at,now()),release_reason=COALESCE(release_reason,$2)
    WHERE booking_id=$1 AND released_at IS NULL RETURNING *`, [bookingId, reason]);
  if (released.rowCount) await client.query('UPDATE parking_bookings SET assigned_zone_id=NULL,assigned_spot_label=NULL WHERE id=$1', [bookingId]);
  return released;
}

async function recordAssignmentArrival(client, bookingId, instant = null) {
  const assignment = await currentAssignment(client, bookingId, { lock: true });
  if (!assignment) throw apiError('SPOT_ALREADY_ASSIGNED', 'This reservation has no current numbered-space assignment', 409);
  const result = await client.query(`UPDATE reservation_spot_assignments
    SET actual_check_in_at=COALESCE(actual_check_in_at,COALESCE($2::timestamptz,now()))
    WHERE id=$1 RETURNING *`, [assignment.id, instant]);
  return result.rows[0];
}

async function recordAssignmentDeparture(client, bookingId, instant = null) {
  const assignment = await currentAssignment(client, bookingId, { lock: true });
  if (!assignment) throw apiError('RESERVATION_NOT_CHECKOUT_ELIGIBLE', 'This reservation has no current numbered-space assignment', 409);
  const result = await client.query(`UPDATE reservation_spot_assignments
    SET actual_check_out_at=COALESCE(actual_check_out_at,
      GREATEST(COALESCE($2::timestamptz,clock_timestamp()),actual_check_in_at))
    WHERE id=$1 RETURNING *`, [assignment.id, instant]);
  return result.rows[0];
}

async function eligibleReassignmentSpots(client, booking, current, { replacementSpotId = null, lock = false } = {}) {
  const occupancyEnd = bookingOccupancyEnd(booking);
  const protectedUntil = addMinutes(occupancyEnd, booking.turnaround_buffer_minutes);
  const product = String(booking.parking_product || '').toUpperCase();
  const duration = product === 'LEGACY' ? 'DAILY'
    : ['DAILY', 'WEEKLY', 'MONTHLY'].includes(product)
      ? product
      : durationFor(booking.arrival_at, occupancyEnd, booking.timezone || 'UTC');
  return client.query(`SELECT s.*,z.name area_name FROM parking_spots s
    JOIN parking_zones z ON z.id=s.zone_id
    JOIN parking_inventory inventory ON inventory.id=s.inventory_id
    JOIN parking_lot_layouts l ON l.location_id=s.location_id AND l.status='PUBLISHED'
    JOIN parking_layout_elements e ON e.layout_id=l.id AND e.parking_spot_id=s.id AND e.active AND e.public_visible
    LEFT JOIN parking_rate_rules plan ON plan.id=e.rate_plan_id AND plan.active
      AND plan.location_id=s.location_id AND plan.category_id=inventory.category_id
      AND (plan.zone_id IS NULL OR plan.zone_id=s.zone_id)
      AND (plan.starts_at IS NULL OR plan.starts_at<=$4) AND (plan.ends_at IS NULL OR plan.ends_at>$4)
    WHERE s.location_id=$1 AND s.inventory_id=$2 AND s.active
      AND s.id ${replacementSpotId == null ? '<>' : '='} $3
      AND CASE WHEN e.parking_purpose IS NULL THEN s.public_bookable ELSE e.space_public_bookable END
      AND COALESCE(e.parking_purpose,CASE WHEN s.parking_use IN ('CUSTOMER','CUSTOMER_BOBTAIL','DAILY','WEEKLY','MONTHLY') THEN 'CUSTOMER' ELSE 'UNRESOLVED' END)='CUSTOMER'
      AND (e.parking_purpose IS NULL
        OR ($6='DAILY' AND e.daily_eligible)
        OR ($6='WEEKLY' AND e.weekly_eligible)
        OR ($6='MONTHLY' AND e.monthly_eligible))
      AND ((e.rate_plan_id IS NOT NULL AND plan.id IS NOT NULL
            AND (($6='DAILY' AND plan.daily_rate_cents IS NOT NULL)
              OR ($6='WEEKLY' AND plan.weekly_rate_cents IS NOT NULL)
              OR ($6='MONTHLY' AND plan.monthly_rate_cents IS NOT NULL)))
        OR (e.rate_plan_id IS NULL AND EXISTS (
          SELECT 1 FROM parking_rate_rules fallback
          WHERE fallback.active AND fallback.location_id=s.location_id
            AND fallback.category_id=inventory.category_id
            AND (fallback.zone_id IS NULL OR fallback.zone_id=s.zone_id)
            AND (fallback.starts_at IS NULL OR fallback.starts_at<=$4)
            AND (fallback.ends_at IS NULL OR fallback.ends_at>$4)
            AND (($6='DAILY' AND fallback.daily_rate_cents IS NOT NULL)
              OR ($6='WEEKLY' AND fallback.weekly_rate_cents IS NOT NULL)
              OR ($6='MONTHLY' AND fallback.monthly_rate_cents IS NOT NULL)))))
      AND s.classification_state='COMPLETE'
      AND NOT EXISTS (SELECT 1 FROM parking_spot_blocks block WHERE block.parking_spot_id=s.id
        AND block.released_at IS NULL AND block.starts_at<$5 AND COALESCE(block.ends_at,'infinity'::timestamptz)>$4)
      AND NOT EXISTS (SELECT 1 FROM reservation_spot_assignments a
        JOIN parking_bookings assigned_booking ON assigned_booking.id=a.booking_id
        WHERE a.parking_spot_id=s.id AND a.released_at IS NULL
          AND assigned_booking.status=ANY($7::text[])
          AND a.reserved_arrival_at<$5 AND a.protected_until_at>$4)
      AND NOT EXISTS (SELECT 1 FROM parking_closures c WHERE c.active AND c.closure_type='FULL_CLOSURE'
        AND c.starts_at<$5 AND c.ends_at>$4
        AND (c.location_id=s.location_id OR c.zone_id=s.zone_id OR c.inventory_id=s.inventory_id OR c.category_id=inventory.category_id))
    ORDER BY s.display_order,s.public_label,s.id${lock ? ' FOR UPDATE OF s' : ''}`,
  [booking.location_id, booking.inventory_id, replacementSpotId == null ? current.parking_spot_id : replacementSpotId,
    booking.arrival_at, protectedUntil, duration, BLOCKING_STATUSES]);
}

async function reassignSpot(client, { bookingId, replacementSpotId, adminUserId, reason, bookingVersion }) {
  const scope = await client.query('SELECT inventory_id FROM parking_bookings WHERE id=$1', [bookingId]);
  if (!scope.rowCount) throw apiError('NOT_FOUND', 'Reservation not found', 404);
  await lockInventoryIds(client, [scope.rows[0].inventory_id]);
  const bookingResult = await client.query(`SELECT b.*,l.turnaround_buffer_minutes
    FROM parking_bookings b JOIN parking_locations l ON l.id=b.location_id
    WHERE b.id=$1 FOR UPDATE OF b`, [bookingId]);
  if (!bookingResult.rowCount) throw apiError('NOT_FOUND', 'Reservation not found', 404);
  const booking = bookingResult.rows[0];
  if (Number(booking.version) !== Number(bookingVersion)) throw apiError('BOOKING_VERSION_CONFLICT', 'This reservation changed; refresh and try again', 409);
  if (!BLOCKING_STATUSES.includes(booking.status)) throw apiError('SPOT_NOT_ELIGIBLE', 'Only confirmed or checked-in reservations can be reassigned', 409);
  const current = await currentAssignment(client, booking.id, { lock: true });
  if (!current) throw apiError('SPOT_NOT_ELIGIBLE', 'This reservation has no current numbered-space assignment', 409);
  if (Number(current.parking_spot_id) === Number(replacementSpotId)) throw apiError('SPOT_ALREADY_ASSIGNED', 'Choose a different numbered space', 409);
  const occupancyEnd = bookingOccupancyEnd(booking);
  const protectedUntil = addMinutes(occupancyEnd, booking.turnaround_buffer_minutes);
  const replacement = await eligibleReassignmentSpots(client, booking, current, { replacementSpotId, lock: true });
  if (!replacement.rowCount) throw apiError('SPOT_NOT_ELIGIBLE', 'The selected numbered space is not eligible for the full reservation interval', 409);
  await client.query(`UPDATE reservation_spot_assignments SET released_at=now(),release_reason=$2
    WHERE id=$1`, [current.id, `Reassigned: ${reason}`]);
  const inserted = await client.query(`INSERT INTO reservation_spot_assignments(
      booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,
      assignment_source,assigned_by_admin_user_id,assignment_reason,previous_assignment_id,actual_check_in_at)
    VALUES($1,$2,$3,$4,$5,'ADMIN_REASSIGN',$6,$7,$8,$9) RETURNING *`, [booking.id,
    replacement.rows[0].id, booking.arrival_at, occupancyEnd, protectedUntil, adminUserId, reason,
    current.id, booking.status === 'CHECKED_IN' ? current.actual_check_in_at || new Date().toISOString() : null]);
  await client.query('UPDATE parking_bookings SET assigned_zone_id=$1,assigned_spot_label=$2,version=version+1,updated_at=now() WHERE id=$3',
    [replacement.rows[0].zone_id, replacement.rows[0].public_label, booking.id]);
  return { assignment: inserted.rows[0], spot: replacement.rows[0], previous: current, booking };
}

function checklistItem(code, label, passed, message) {
  return { code, label, passed: Boolean(passed), ...(passed ? {} : { message }) };
}

async function setupChecklist(client, locationId, { layoutId = null, physicalConfirmation = false } = {}) {
  const location = (await client.query('SELECT * FROM parking_locations WHERE id=$1', [locationId])).rows[0];
  if (!location) throw apiError('NOT_FOUND', 'Parking lot not found', 404);
  const layout = (await client.query(`SELECT * FROM parking_lot_layouts
    WHERE location_id=$1 AND ($2::bigint IS NULL OR id=$2)
    ORDER BY CASE status WHEN 'DRAFT' THEN 0 ELSE 1 END LIMIT 1`, [locationId, layoutId])).rows[0];
  const areas = await client.query('SELECT * FROM parking_zones WHERE location_id=$1 AND active ORDER BY display_order,id', [locationId]);
  const spots = await client.query(`SELECT spot.* FROM parking_spots spot
    WHERE spot.location_id=$1 AND (
      ($2::bigint IS NULL AND spot.active)
      OR ($2::bigint IS NOT NULL AND EXISTS (
        SELECT 1 FROM parking_layout_elements element
        WHERE element.layout_id=$2 AND element.parking_spot_id=spot.id AND element.active
      ))
    ) ORDER BY spot.display_order,spot.public_label,spot.id`, [locationId, layoutId]);
  const links = layout ? await client.query(`SELECT parking_spot_id,count(*)::int link_count FROM parking_layout_elements
    WHERE layout_id=$1 AND active AND parking_spot_id IS NOT NULL GROUP BY parking_spot_id`, [layout.id]) : { rows: [] };
  const elements = layout ? await client.query('SELECT * FROM parking_layout_elements WHERE layout_id=$1 AND active', [layout.id]) : { rows: [] };
  const directions = await client.query('SELECT * FROM parking_area_directions WHERE location_id=$1', [locationId]);
  const linksBySpot = new Map(links.rows.map(row => [String(row.parking_spot_id), Number(row.link_count)]));
  const directionByZone = new Map(directions.rows.map(row => [String(row.zone_id), row]));
  const activeElements = elements.rows;
  const entranceKeys = new Set(activeElements.filter(item => item.element_type === 'ENTRANCE').map(item => item.element_key));
  const exitKeys = new Set(activeElements.filter(item => item.element_type === 'EXIT').map(item => item.element_key));
  const elementKeys = new Set(activeElements.map(item => item.element_key));
  const publicAreas = areas.rows.filter(area => area.public_visible);
  const allReferencesValid = publicAreas.every(area => {
    const direction = directionByZone.get(String(area.id));
    if (!direction) return false;
    return entranceKeys.has(direction.entrance_element_key) && exitKeys.has(direction.exit_element_key)
      && [...direction.arrival_route_element_keys, ...direction.exit_route_element_keys].every(key => elementKeys.has(key));
  });
  const checks = [
    checklistItem('ADDRESS_CONFIGURED', 'Address configured', location.address?.trim(), 'Add the parking lot street address.'),
    checklistItem('TIMEZONE_CONFIGURED', 'Timezone configured', location.timezone?.trim(), 'Choose the parking lot IANA timezone.'),
    checklistItem('SUPPORT_PHONE_CONFIGURED', 'Support phone configured', location.phone?.trim(), 'Add a customer support phone number.'),
    checklistItem('ROAD_DIRECTIONS_CONFIGURED', 'Road-directions URL configured', /^https?:\/\//i.test(location.road_directions_url || ''), 'Add a valid road-directions URL.'),
    checklistItem('MAIN_ENTRANCE_CONFIGURED', 'Main entrance configured', entranceKeys.size > 0, 'Add a main entrance to the draft map.'),
    checklistItem('EXIT_CONFIGURED', 'Exit configured', exitKeys.size > 0, 'Add an exit to the draft map.'),
    checklistItem('ACTIVE_AREA_EXISTS', 'At least one active parking area exists', areas.rowCount > 0, 'Add and activate a parking area.'),
    checklistItem('ACTIVE_SPOT_EXISTS', 'At least one active numbered space exists', spots.rowCount > 0, 'Generate at least one numbered space.'),
    checklistItem('UNIQUE_SPACE_LABELS', 'Every active space has a unique public label', true, 'Resolve duplicate numbered-space labels.'),
    checklistItem('SPACE_AREA_LINKS', 'Every active space belongs to a parking area', spots.rows.every(spot => spot.zone_id), 'Link every numbered space to a parking area.'),
    checklistItem('SPACE_INVENTORY_LINKS', 'Every active space links to a vehicle type', spots.rows.every(spot => spot.inventory_id), 'Link every numbered space to a vehicle type.'),
    checklistItem('SPACE_VISUAL_LINKS', 'Every active space links to one visual element', spots.rows.length > 0 && spots.rows.every(spot => linksBySpot.get(String(spot.id)) === 1), 'Regenerate or link every numbered space on the draft map.'),
    checklistItem('NO_DUPLICATE_VISUAL_LINKS', 'No visual element links to multiple spaces', links.rows.every(row => row.link_count === 1), 'Resolve duplicate visual space links.'),
    checklistItem('AREA_ARRIVAL_DIRECTIONS', 'Every public parking area has arrival directions', publicAreas.length > 0 && publicAreas.every(area => area.arrival_directions.trim()), 'Add arrival directions for every public parking area.'),
    checklistItem('AREA_EXIT_DIRECTIONS', 'Every public parking area has exit directions', publicAreas.length > 0 && publicAreas.every(area => area.exit_directions.trim()), 'Add exit directions for every public parking area.'),
    checklistItem('ROUTE_REFERENCES_VALID', 'Published routes reference existing map elements', allReferencesValid, 'Choose valid entrance, exit, and route elements for every public parking area.'),
    checklistItem('MAP_READABLE', 'Published map is readable', Boolean(layout) && activeElements.length >= spots.rows.length + 2, 'Add the numbered spaces, entrance, exit, and supporting map elements.'),
    checklistItem('PHYSICAL_LAYOUT_CONFIRMED', 'Physical-lot confirmation accepted', physicalConfirmation || location.physical_layout_confirmed_at, 'Confirm that the physical lot matches this layout.')
  ];
  return { ready: checks.every(check => check.passed), checks, location, layout, areas: areas.rows, spots: spots.rows };
}

async function liveLot(client, locationId, at = new Date().toISOString(), { zoneId = null, categoryCode = null } = {}) {
  const location = (await client.query('SELECT id,name,timezone,assignment_mode,exact_mode_active FROM parking_locations WHERE id=$1', [locationId])).rows[0];
  if (!location) throw apiError('NOT_FOUND', 'Parking lot not found', 404);
  const result = await client.query(`SELECT s.id,s.public_label,s.display_order,s.active,s.internal_notes,
      s.zone_id,s.inventory_id,z.name area_name,c.code category_code,c.name category_name,
      e.x,e.y,e.width,e.height,e.rotation,e.element_key,
      block.id block_id,block.reason block_reason,block.public_message,
      a.id assignment_id,a.actual_check_in_at,a.actual_check_out_at,
      b.id booking_id,b.reservation_number,b.status booking_status,b.arrival_at,b.departure_at,b.first_name,b.last_name,
      CASE
        WHEN NOT s.active THEN 'INACTIVE'
        WHEN block.id IS NOT NULL THEN 'BLOCKED'
        WHEN b.status='CHECKED_IN' AND b.departure_at<$2 THEN 'OVERDUE'
        WHEN b.status='CHECKED_IN' THEN 'OCCUPIED'
        WHEN b.status='CONFIRMED' THEN 'RESERVED'
        ELSE 'AVAILABLE'
      END state
    FROM parking_spots s
    JOIN parking_zones z ON z.id=s.zone_id
    JOIN parking_inventory i ON i.id=s.inventory_id
    JOIN parking_categories c ON c.id=i.category_id
    LEFT JOIN parking_lot_layouts l ON l.location_id=s.location_id AND l.status='PUBLISHED'
    LEFT JOIN parking_layout_elements e ON e.layout_id=l.id AND e.parking_spot_id=s.id AND e.active
    LEFT JOIN LATERAL (
      SELECT * FROM parking_spot_blocks item WHERE item.parking_spot_id=s.id AND item.released_at IS NULL
        AND item.starts_at<=$2 AND COALESCE(item.ends_at,'infinity'::timestamptz)>$2 ORDER BY item.starts_at DESC LIMIT 1
    ) block ON true
    LEFT JOIN LATERAL (
      SELECT item.* FROM reservation_spot_assignments item JOIN parking_bookings booking ON booking.id=item.booking_id
      WHERE item.parking_spot_id=s.id AND item.released_at IS NULL
        AND (item.reserved_arrival_at<=$2 OR (booking.status='CHECKED_IN' AND item.actual_check_in_at IS NOT NULL))
        AND item.protected_until_at>$2
        AND booking.status=ANY($3::text[]) ORDER BY item.assigned_at DESC LIMIT 1
    ) a ON true
    LEFT JOIN parking_bookings b ON b.id=a.booking_id
    WHERE s.location_id=$1 AND s.active AND ($4::bigint IS NULL OR s.zone_id=$4)
      AND ($5::text IS NULL OR c.code=$5)
    ORDER BY z.display_order,z.name,s.display_order,s.public_label,s.id`, [locationId, at, BLOCKING_STATUSES, zoneId, categoryCode]);
  const summary = { AVAILABLE: 0, RESERVED: 0, OCCUPIED: 0, BLOCKED: 0, OVERDUE: 0, INACTIVE: 0 };
  result.rows.forEach(spot => { summary[spot.state] += 1; });
  return { location, at, summary, spots: result.rows };
}

module.exports = {
  BLOCKING_STATUSES,
  addMinutes,
  expireQuoteHolds,
  assignExactSpot,
  assignSelectedExactSpot,
  selectExactSpot,
  currentAssignment,
  releaseCurrentAssignment,
  recordAssignmentArrival,
  recordAssignmentDeparture,
  eligibleReassignmentSpots,
  reassignSpot,
  setupChecklist,
  liveLot
};
