-- Daily customer parking remains a highlighted-area capacity commitment.
-- Monthly customer parking binds the exact physical position selected by the
-- customer. Historical automatic exact assignments remain readable.

ALTER TABLE parking_bookings
  DROP CONSTRAINT IF EXISTS parking_bookings_assignment_mode_snapshot_valid;
ALTER TABLE parking_bookings
  ADD CONSTRAINT parking_bookings_assignment_mode_snapshot_valid
    CHECK (assignment_mode_snapshot IN ('ZONE_CAPACITY','CUSTOMER_SELECTED_SPOT','EXACT_SPOT'));

ALTER TABLE parking_public_quotes
  DROP CONSTRAINT IF EXISTS parking_public_quotes_assignment_spot_consistent,
  DROP CONSTRAINT IF EXISTS parking_public_quotes_assignment_mode_valid;
ALTER TABLE parking_public_quotes
  ADD CONSTRAINT parking_public_quotes_assignment_mode_valid
    CHECK (assignment_mode IN ('ZONE_CAPACITY','CUSTOMER_SELECTED_SPOT','EXACT_SPOT')),
  ADD CONSTRAINT parking_public_quotes_assignment_spot_consistent
    CHECK (
      (assignment_mode='ZONE_CAPACITY' AND parking_spot_id IS NULL)
      OR
      (assignment_mode IN ('CUSTOMER_SELECTED_SPOT','EXACT_SPOT') AND parking_spot_id IS NOT NULL)
  ),
  ADD COLUMN IF NOT EXISTS hold_released_at timestamptz,
  ADD COLUMN IF NOT EXISTS protected_until_at timestamptz;

UPDATE parking_public_quotes
SET protected_until_at=departure_at
WHERE protected_until_at IS NULL;

ALTER TABLE parking_public_quotes
  ALTER COLUMN protected_until_at SET NOT NULL,
  ADD CONSTRAINT parking_public_quotes_protected_interval_valid
    CHECK (protected_until_at>=departure_at),
  ADD COLUMN IF NOT EXISTS hold_period tstzrange GENERATED ALWAYS AS
    (tstzrange(arrival_at,protected_until_at,'[)')) STORED;

ALTER TABLE reservation_spot_assignments
  DROP CONSTRAINT IF EXISTS reservation_spot_assignments_assignment_source_check;
ALTER TABLE reservation_spot_assignments
  ADD CONSTRAINT reservation_spot_assignments_assignment_source_check
    CHECK (assignment_source IN ('CUSTOMER_AUTO','CUSTOMER_SELECTED','ADMIN_REASSIGN','SYSTEM'));

ALTER TABLE parking_bookings
  DROP CONSTRAINT IF EXISTS parking_bookings_company_name_valid;
ALTER TABLE parking_bookings
  ADD CONSTRAINT parking_bookings_company_name_valid
    CHECK (company_name IS NULL OR length(trim(company_name)) BETWEEN 1 AND 120);

CREATE INDEX IF NOT EXISTS parking_bookings_company_name_search_idx
  ON parking_bookings(lower(company_name)) WHERE company_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS parking_public_quotes_selected_spot_lookup_idx
  ON parking_public_quotes(parking_spot_id,expires_at)
  WHERE assignment_mode='CUSTOMER_SELECTED_SPOT'
    AND consumed_booking_id IS NULL AND hold_released_at IS NULL;

ALTER TABLE parking_public_quotes
  DROP CONSTRAINT IF EXISTS parking_public_quotes_selected_spot_hold_exclusion;
ALTER TABLE parking_public_quotes
  ADD CONSTRAINT parking_public_quotes_selected_spot_hold_exclusion
  EXCLUDE USING gist (parking_spot_id WITH =, hold_period WITH &&)
  WHERE (
    assignment_mode='CUSTOMER_SELECTED_SPOT'
    AND consumed_booking_id IS NULL
    AND hold_released_at IS NULL
  );

CREATE OR REPLACE FUNCTION parking_public_quote_assignment_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignment_mode IS NULL THEN
    NEW.assignment_mode := CASE WHEN NEW.parking_spot_id IS NULL THEN 'ZONE_CAPACITY' ELSE 'EXACT_SPOT' END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION parking_assignment_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM parking_bookings booking
    JOIN parking_spots spot ON spot.id=NEW.parking_spot_id
    WHERE booking.id=NEW.booking_id
      AND booking.assignment_mode_snapshot IN ('CUSTOMER_SELECTED_SPOT','EXACT_SPOT')
      AND booking.location_id=spot.location_id
      AND booking.inventory_id=spot.inventory_id
      AND booking.category_id=(SELECT category_id FROM parking_inventory WHERE id=spot.inventory_id)
      AND booking.arrival_at=NEW.reserved_arrival_at
      AND booking.departure_at=NEW.reserved_departure_at
  ) THEN
    RAISE EXCEPTION 'spot assignment requires a customer-selected monthly or historical exact booking with matching scope and interval';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION parking_public_quote_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignment_mode IS DISTINCT FROM OLD.assignment_mode
    OR NEW.parking_spot_id IS DISTINCT FROM OLD.parking_spot_id
    OR NEW.location_id IS DISTINCT FROM OLD.location_id
    OR NEW.inventory_id IS DISTINCT FROM OLD.inventory_id
    OR NEW.rate_rule_id IS DISTINCT FROM OLD.rate_rule_id
    OR NEW.arrival_at IS DISTINCT FROM OLD.arrival_at
    OR NEW.departure_at IS DISTINCT FROM OLD.departure_at
    OR NEW.protected_until_at IS DISTINCT FROM OLD.protected_until_at
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.pricing_snapshot IS DISTINCT FROM OLD.pricing_snapshot
    OR NEW.rate_basis_hash IS DISTINCT FROM OLD.rate_basis_hash
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'quote scope, price, assignment behavior, and selected position are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parking_public_quote_binding_immutable_trigger ON parking_public_quotes;
CREATE TRIGGER parking_public_quote_binding_immutable_trigger
  BEFORE UPDATE OF assignment_mode,parking_spot_id,location_id,inventory_id,rate_rule_id,
    arrival_at,departure_at,protected_until_at,request_hash,pricing_snapshot,rate_basis_hash,expires_at
  ON parking_public_quotes
  FOR EACH ROW EXECUTE FUNCTION parking_public_quote_binding_immutable();
