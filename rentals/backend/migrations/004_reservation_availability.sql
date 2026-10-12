-- Operational vehicle state is separate from date-based reservation availability.
-- All timestamps remain TIMESTAMPTZ; unqualified customer input is interpreted as America/Chicago by the API.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM vehicles
    WHERE UPPER(status) NOT IN ('AVAILABLE', 'READY', 'RESERVED', 'RENTED', 'CLEANING', 'MAINTENANCE', 'SERVICE', 'INACTIVE', 'UNAVAILABLE', 'RETIRED', 'OUT_OF_SERVICE')
  ) THEN
    RAISE EXCEPTION 'Cannot migrate vehicle statuses: unsupported legacy status values exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM reservationsmvp
    WHERE UPPER(status) NOT IN ('PENDING', 'PENDING_REQUEST', 'APPROVED', 'RESERVED', 'CONFIRMED', 'REJECTED', 'DECLINED', 'CANCELLED', 'ACTIVE', 'RENTED', 'CHECKED_OUT', 'CLOSED', 'COMPLETED', 'NO_SHOW')
  ) THEN
    RAISE EXCEPTION 'Cannot migrate reservation statuses: unsupported legacy status values exist';
  END IF;
END $$;

UPDATE vehicles
SET status = CASE UPPER(status)
  WHEN 'AVAILABLE' THEN 'READY'
  WHEN 'READY' THEN 'READY'
  WHEN 'RESERVED' THEN 'READY'
  WHEN 'RENTED' THEN 'OUT_OF_SERVICE'
  WHEN 'CLEANING' THEN 'MAINTENANCE'
  WHEN 'MAINTENANCE' THEN 'MAINTENANCE'
  WHEN 'SERVICE' THEN 'MAINTENANCE'
  WHEN 'INACTIVE' THEN 'RETIRED'
  WHEN 'UNAVAILABLE' THEN 'RETIRED'
  WHEN 'RETIRED' THEN 'RETIRED'
  WHEN 'OUT_OF_SERVICE' THEN 'OUT_OF_SERVICE'
END;

ALTER TABLE vehicles ALTER COLUMN status SET DEFAULT 'READY';
ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_operational_status_check
  CHECK (UPPER(status) IN ('READY', 'MAINTENANCE', 'OUT_OF_SERVICE', 'RETIRED'));

UPDATE reservationsmvp
SET status = CASE UPPER(status)
  WHEN 'PENDING' THEN 'PENDING_REQUEST'
  WHEN 'PENDING_REQUEST' THEN 'PENDING_REQUEST'
  WHEN 'APPROVED' THEN 'CONFIRMED'
  WHEN 'RESERVED' THEN 'CONFIRMED'
  WHEN 'CONFIRMED' THEN 'CONFIRMED'
  WHEN 'REJECTED' THEN 'DECLINED'
  WHEN 'DECLINED' THEN 'DECLINED'
  WHEN 'CANCELLED' THEN 'CANCELLED'
  WHEN 'ACTIVE' THEN 'CHECKED_OUT'
  WHEN 'RENTED' THEN 'CHECKED_OUT'
  WHEN 'CHECKED_OUT' THEN 'CHECKED_OUT'
  WHEN 'CLOSED' THEN 'COMPLETED'
  WHEN 'COMPLETED' THEN 'COMPLETED'
  WHEN 'NO_SHOW' THEN 'NO_SHOW'
END;

ALTER TABLE reservationsmvp ALTER COLUMN status SET DEFAULT 'PENDING_REQUEST';
ALTER TABLE reservationsmvp
  ADD CONSTRAINT reservationsmvp_status_transition_values_check
  CHECK (UPPER(status) IN ('PENDING_REQUEST', 'CONFIRMED', 'DECLINED', 'CANCELLED', 'CHECKED_OUT', 'COMPLETED', 'NO_SHOW'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM reservationsmvp earlier
    JOIN reservationsmvp later ON later.vehicleid = earlier.vehicleid
      AND later.reservationid > earlier.reservationid
      AND tstzrange(earlier.pickupat, earlier.returnat, '[)') && tstzrange(later.pickupat, later.returnat, '[)')
    WHERE UPPER(earlier.status) IN ('CONFIRMED', 'CHECKED_OUT')
      AND UPPER(later.status) IN ('CONFIRMED', 'CHECKED_OUT')
  ) THEN
    RAISE EXCEPTION 'Cannot add reservation overlap protection: existing CONFIRMED/CHECKED_OUT reservations overlap';
  END IF;
END $$;

ALTER TABLE reservationsmvp
  ADD CONSTRAINT reservationsmvp_blocking_interval_exclusion
  EXCLUDE USING gist (
    vehicleid WITH =,
    tstzrange(pickupat, returnat, '[)') WITH &&
  ) WHERE (UPPER(status) IN ('CONFIRMED', 'CHECKED_OUT'));

CREATE INDEX IF NOT EXISTS idx_reservationsmvp_blocking_interval
  ON reservationsmvp USING gist (vehicleid, tstzrange(pickupat, returnat, '[)'))
  WHERE UPPER(status) IN ('CONFIRMED', 'CHECKED_OUT');
