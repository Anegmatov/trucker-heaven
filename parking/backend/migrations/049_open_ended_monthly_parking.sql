BEGIN;

-- Active Monthly parking is continuous occupancy.  Its business end is NULL;
-- exact-space assignments retain their own finite technical reservation end.
ALTER TABLE parking_bookings
  ALTER COLUMN departure_at DROP NOT NULL;

ALTER TABLE parking_bookings
  DROP CONSTRAINT IF EXISTS parking_bookings_departure_at_check;
ALTER TABLE parking_bookings
  ADD CONSTRAINT parking_bookings_departure_at_check CHECK (
    departure_at IS NULL OR departure_at>arrival_at
  );

CREATE OR REPLACE FUNCTION parking_assignment_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM parking_bookings b JOIN parking_spots s ON s.id=NEW.parking_spot_id
    WHERE b.id=NEW.booking_id
      AND b.assignment_mode_snapshot IN ('CUSTOMER_SELECTED_SPOT','EXACT_SPOT')
      AND b.location_id=s.location_id
      AND b.inventory_id=s.inventory_id AND b.category_id=(SELECT category_id FROM parking_inventory WHERE id=s.inventory_id)
      AND b.arrival_at=NEW.reserved_arrival_at
      AND (b.departure_at=NEW.reserved_departure_at
        OR (b.parking_product='MONTHLY' AND b.departure_at IS NULL
          AND NEW.reserved_departure_at='9999-12-31T23:59:59.999Z'::timestamptz))
  ) THEN
    RAISE EXCEPTION 'spot assignment requires a customer-selected monthly or historical exact booking with matching scope and interval';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
