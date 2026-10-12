-- A pending payment attempt may retain a requested Monthly position, but it
-- must never be an operational reservation.  Final assignment happens only
-- when the payment lifecycle verifies Stripe or consumes an authorized demo
-- token.
ALTER TABLE parking_bookings
  ADD COLUMN IF NOT EXISTS requested_parking_spot_id bigint
    REFERENCES parking_spots(id) ON DELETE RESTRICT;

-- Preserve the selected position from older pending Reservation Desk records
-- before releasing their premature assignments.
UPDATE parking_bookings booking
SET requested_parking_spot_id=(
  SELECT assignment.parking_spot_id FROM reservation_spot_assignments assignment
  WHERE assignment.booking_id=booking.id AND assignment.released_at IS NULL
  ORDER BY assignment.assigned_at DESC,assignment.id DESC LIMIT 1
)
WHERE booking.status='PENDING'
  AND booking.assignment_mode_snapshot='CUSTOMER_SELECTED_SPOT'
  AND booking.requested_parking_spot_id IS NULL
  AND EXISTS (SELECT 1 FROM reservation_spot_assignments assignment
    WHERE assignment.booking_id=booking.id AND assignment.released_at IS NULL);

UPDATE reservation_spot_assignments assignment
SET released_at=COALESCE(assignment.released_at,now()),
    release_reason=COALESCE(assignment.release_reason,'Unpaid booking attempts do not reserve parking')
FROM parking_bookings booking
WHERE booking.id=assignment.booking_id
  AND booking.status='PENDING'
  AND assignment.released_at IS NULL;

UPDATE parking_bookings
SET assigned_zone_id=NULL,assigned_spot_label=NULL
WHERE status='PENDING';

DROP INDEX IF EXISTS bookings_availability_idx;
CREATE INDEX bookings_availability_idx
  ON parking_bookings(inventory_id,arrival_at,departure_at)
  WHERE status IN ('CONFIRMED','CHECKED_IN');

DROP INDEX IF EXISTS parking_bookings_area_capacity_overlap_idx;
CREATE INDEX parking_bookings_area_capacity_overlap_idx
  ON parking_bookings(inventory_id,assignment_mode_snapshot,arrival_at,departure_at)
  WHERE status IN ('CONFIRMED','CHECKED_IN');

ALTER TABLE parking_public_quotes
  DROP CONSTRAINT IF EXISTS parking_public_quotes_selected_spot_hold_exclusion;

CREATE INDEX IF NOT EXISTS parking_bookings_requested_spot_idx
  ON parking_bookings(requested_parking_spot_id)
  WHERE requested_parking_spot_id IS NOT NULL;
