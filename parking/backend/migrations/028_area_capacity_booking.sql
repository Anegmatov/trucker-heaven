-- Preserve the assignment model used when each reservation and quote was
-- created. Location settings may change later, but historical behavior must
-- continue to follow the immutable booking snapshot.
ALTER TABLE parking_bookings
  ADD COLUMN assignment_mode_snapshot text;

UPDATE parking_bookings booking
SET assignment_mode_snapshot=CASE
  WHEN EXISTS (
    SELECT 1 FROM reservation_spot_assignments assignment
    WHERE assignment.booking_id=booking.id
  ) THEN 'EXACT_SPOT'
  ELSE 'ZONE_CAPACITY'
END;

ALTER TABLE parking_bookings
  ALTER COLUMN assignment_mode_snapshot SET NOT NULL,
  ADD CONSTRAINT parking_bookings_assignment_mode_snapshot_valid
    CHECK (assignment_mode_snapshot IN ('ZONE_CAPACITY','EXACT_SPOT'));

-- Current application writes the snapshot explicitly. This compatibility
-- trigger keeps trusted importers and older operational fixtures working while
-- still making the stored value immutable from later location-mode changes.
CREATE OR REPLACE FUNCTION parking_booking_assignment_mode_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignment_mode_snapshot IS NULL THEN
    SELECT assignment_mode INTO NEW.assignment_mode_snapshot
    FROM parking_locations WHERE id=NEW.location_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parking_booking_assignment_mode_snapshot_trigger ON parking_bookings;
CREATE TRIGGER parking_booking_assignment_mode_snapshot_trigger
  BEFORE INSERT ON parking_bookings
  FOR EACH ROW EXECUTE FUNCTION parking_booking_assignment_mode_snapshot();

CREATE OR REPLACE FUNCTION parking_assignment_mode_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignment_mode_snapshot IS DISTINCT FROM OLD.assignment_mode_snapshot THEN
    RAISE EXCEPTION 'booking assignment mode snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parking_booking_assignment_mode_immutable_trigger ON parking_bookings;
CREATE TRIGGER parking_booking_assignment_mode_immutable_trigger
  BEFORE UPDATE OF assignment_mode_snapshot ON parking_bookings
  FOR EACH ROW EXECUTE FUNCTION parking_assignment_mode_immutable();

ALTER TABLE parking_public_quotes
  ADD COLUMN assignment_mode text;

UPDATE parking_public_quotes
SET assignment_mode=CASE
  WHEN parking_spot_id IS NOT NULL THEN 'EXACT_SPOT'
  ELSE 'ZONE_CAPACITY'
END;

ALTER TABLE parking_public_quotes
  ALTER COLUMN assignment_mode SET NOT NULL,
  ADD CONSTRAINT parking_public_quotes_assignment_mode_valid
    CHECK (assignment_mode IN ('ZONE_CAPACITY','EXACT_SPOT')),
  ADD CONSTRAINT parking_public_quotes_assignment_spot_consistent
    CHECK ((assignment_mode='EXACT_SPOT')=(parking_spot_id IS NOT NULL));

CREATE OR REPLACE FUNCTION parking_public_quote_assignment_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignment_mode IS NULL THEN
    NEW.assignment_mode := CASE WHEN NEW.parking_spot_id IS NULL THEN 'ZONE_CAPACITY' ELSE 'EXACT_SPOT' END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parking_public_quote_assignment_mode_trigger ON parking_public_quotes;
CREATE TRIGGER parking_public_quote_assignment_mode_trigger
  BEFORE INSERT ON parking_public_quotes
  FOR EACH ROW EXECUTE FUNCTION parking_public_quote_assignment_mode();

CREATE OR REPLACE FUNCTION parking_public_quote_assignment_mode_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignment_mode IS DISTINCT FROM OLD.assignment_mode THEN
    RAISE EXCEPTION 'quote assignment mode is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parking_public_quote_assignment_mode_immutable_trigger ON parking_public_quotes;
CREATE TRIGGER parking_public_quote_assignment_mode_immutable_trigger
  BEFORE UPDATE OF assignment_mode ON parking_public_quotes
  FOR EACH ROW EXECUTE FUNCTION parking_public_quote_assignment_mode_immutable();

CREATE INDEX parking_bookings_area_capacity_overlap_idx
  ON parking_bookings(inventory_id,assignment_mode_snapshot,arrival_at,departure_at)
  WHERE status IN ('PENDING','CONFIRMED','CHECKED_IN');

CREATE INDEX parking_public_quotes_mode_inventory_idx
  ON parking_public_quotes(inventory_id,assignment_mode,expires_at)
  WHERE consumed_booking_id IS NULL;

CREATE OR REPLACE FUNCTION parking_assignment_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM parking_bookings b JOIN parking_spots s ON s.id=NEW.parking_spot_id
    WHERE b.id=NEW.booking_id AND b.assignment_mode_snapshot='EXACT_SPOT'
      AND b.location_id=s.location_id
      AND b.inventory_id=s.inventory_id AND b.category_id=(SELECT category_id FROM parking_inventory WHERE id=s.inventory_id)
      AND b.arrival_at=NEW.reserved_arrival_at AND b.departure_at=NEW.reserved_departure_at
  ) THEN
    RAISE EXCEPTION 'spot assignment requires an exact-space booking with matching location, inventory, category, and interval';
  END IF;
  RETURN NEW;
END;
$$;
