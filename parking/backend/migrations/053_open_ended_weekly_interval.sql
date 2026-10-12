BEGIN;

-- Weekly parking is now prospectively open-ended, matching the existing
-- nullable interval shape used by Monthly parking. Existing finite Weekly
-- rows are left unchanged. Daily, Legacy, and any other products retain the
-- finite-departure invariant established by migration 050.
ALTER TABLE parking_bookings
  DROP CONSTRAINT IF EXISTS parking_bookings_departure_at_check;
ALTER TABLE parking_bookings
  ADD CONSTRAINT parking_bookings_departure_at_check CHECK (
    (parking_product IN ('WEEKLY','MONTHLY')
      AND (departure_at IS NULL OR departure_at>arrival_at))
    OR (parking_product NOT IN ('WEEKLY','MONTHLY')
      AND departure_at IS NOT NULL AND departure_at>arrival_at)
  );

COMMIT;
