CREATE OR REPLACE FUNCTION parking_validate_booking_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM parking_inventory i JOIN parking_zones z ON z.id=i.zone_id
    WHERE i.id=NEW.inventory_id AND z.location_id=NEW.location_id AND i.category_id=NEW.category_id
  ) THEN
    RAISE EXCEPTION 'booking inventory, location, and category must belong together';
  END IF;
  IF NEW.assigned_zone_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM parking_zones z WHERE z.id=NEW.assigned_zone_id AND z.location_id=NEW.location_id) THEN
    RAISE EXCEPTION 'assigned zone must belong to booking location';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER parking_booking_relationships_valid
BEFORE INSERT OR UPDATE OF inventory_id,location_id,category_id,assigned_zone_id ON parking_bookings
FOR EACH ROW EXECUTE FUNCTION parking_validate_booking_relationships();

CREATE OR REPLACE FUNCTION parking_validate_rate_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.zone_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM parking_zones z WHERE z.id=NEW.zone_id AND z.location_id=NEW.location_id) THEN
    RAISE EXCEPTION 'rate zone must belong to rate location';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER parking_rate_relationships_valid
BEFORE INSERT OR UPDATE OF location_id,zone_id ON parking_rate_rules
FOR EACH ROW EXECUTE FUNCTION parking_validate_rate_relationships();
