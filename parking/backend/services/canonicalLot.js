const { apiError } = require('../utils');

const CANONICAL_LAYOUT_PREFIX = 'Trucker Heaven physical lot';

// A canonical physical layout is the production fence for the one public lot.
// Do not replace this with an arbitrary "first active location" fallback: the
// legacy location and zone rows remain valid historical persistence records.
async function resolveCanonicalLot(client) {
  const result = await client.query(`SELECT l.id,l.public_id,l.name,l.address,l.timezone,l.phone,
      l.arrival_instructions,l.exit_instructions,l.road_directions_url,l.payment_instructions,
      l.cancellation_cutoff_hours,l.booking_approval_mode,l.assignment_mode,l.exact_mode_active,l.self_service_enabled,
      l.check_in_early_minutes,l.check_in_late_minutes,l.turnaround_buffer_minutes,
      layout.id layout_id,layout.name layout_name,layout.version layout_version,layout.published_at
    FROM parking_locations l
    JOIN parking_lot_layouts layout ON layout.location_id=l.id
      AND layout.status='PUBLISHED' AND layout.name LIKE $1
    WHERE l.active
    ORDER BY layout.published_at DESC,layout.id DESC`, [`${CANONICAL_LAYOUT_PREFIX}%`]);
  if (result.rowCount !== 1) {
    throw apiError('CANONICAL_LOT_UNAVAILABLE', 'The canonical parking lot is unavailable.', 503);
  }
  return { ...result.rows[0], canonical_customer_lot: true };
}

async function canonicalPublicCategories(client, locationId) {
  const result = await client.query(`SELECT c.code,
      CASE c.code WHEN 'BOBTAIL' THEN 'Bobtail' WHEN 'TRACTOR_TRAILER' THEN 'General Truck Parking' ELSE c.name END name
    FROM parking_spots s
    JOIN parking_lot_layouts l ON l.location_id=s.location_id AND l.status='PUBLISHED'
    JOIN parking_layout_elements e ON e.layout_id=l.id AND e.parking_spot_id=s.id AND e.active AND e.public_visible
    JOIN parking_inventory i ON i.id=e.inventory_id AND i.active
    JOIN parking_zones z ON z.id=s.zone_id AND z.active AND z.public_visible
    JOIN parking_categories c ON c.id=i.category_id AND c.active
    WHERE s.location_id=$1 AND s.active AND e.space_public_bookable
      AND e.parking_purpose='CUSTOMER'
      AND s.classification_state='COMPLETE'
      AND c.code IN ('BOBTAIL','TRACTOR_TRAILER')
    GROUP BY c.code,c.name
    ORDER BY CASE c.code WHEN 'BOBTAIL' THEN 1 WHEN 'TRACTOR_TRAILER' THEN 2 ELSE 3 END`, [locationId]);
  return result.rows;
}

module.exports = { CANONICAL_LAYOUT_PREFIX, resolveCanonicalLot, canonicalPublicCategories };
