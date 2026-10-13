-- A booking keeps the driver's vehicle type (category) even when it is placed in an
-- inventory of another type that accepts it (bobtails in the truck Daily area, see 060).
-- The relationship triggers accept that pairing alongside the exact-match one.
CREATE OR REPLACE FUNCTION parking_validate_booking_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM parking_inventory i JOIN parking_zones z ON z.id=i.zone_id
    WHERE i.id=NEW.inventory_id AND z.location_id=NEW.location_id
      AND (i.category_id=NEW.category_id
        OR (SELECT c.code FROM parking_categories c WHERE c.id=NEW.category_id)=ANY(i.accepts_category_codes))
  ) THEN
    RAISE EXCEPTION 'booking inventory, location, and category must belong together';
  END IF;
  IF NEW.assigned_zone_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM parking_zones z WHERE z.id=NEW.assigned_zone_id AND z.location_id=NEW.location_id) THEN
    RAISE EXCEPTION 'assigned zone must belong to booking location';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION parking_assignment_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM parking_bookings b JOIN parking_spots s ON s.id=NEW.parking_spot_id
    JOIN parking_inventory i ON i.id=s.inventory_id
    WHERE b.id=NEW.booking_id
      AND b.assignment_mode_snapshot IN ('CUSTOMER_SELECTED_SPOT','EXACT_SPOT')
      AND b.location_id=s.location_id
      AND b.inventory_id=s.inventory_id
      AND (b.category_id=i.category_id
        OR (SELECT c.code FROM parking_categories c WHERE c.id=b.category_id)=ANY(i.accepts_category_codes))
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
