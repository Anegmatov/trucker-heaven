ALTER TABLE parking_rate_rules
  ADD CONSTRAINT parking_rate_rules_duration_required
  CHECK (daily_rate_cents IS NOT NULL OR weekly_rate_cents IS NOT NULL OR monthly_rate_cents IS NOT NULL);

ALTER TABLE parking_closures DROP CONSTRAINT IF EXISTS parking_closures_scope_check;
ALTER TABLE parking_closures
  ADD CONSTRAINT parking_closures_single_scope_check CHECK (
    (CASE WHEN location_id IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN zone_id IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN inventory_id IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN category_id IS NULL THEN 0 ELSE 1 END) = 1
  ),
  ADD CONSTRAINT parking_closures_reduction_type_check CHECK (
    (closure_type='FULL_CLOSURE' AND capacity_reduction=0)
    OR (closure_type='CAPACITY_REDUCTION' AND capacity_reduction>0)
  );

CREATE OR REPLACE FUNCTION parking_prevent_zone_reassignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id AND EXISTS (
    SELECT 1 FROM parking_inventory i JOIN parking_bookings b ON b.inventory_id=i.id WHERE i.zone_id=OLD.id
    UNION ALL SELECT 1 FROM parking_rate_rules WHERE zone_id=OLD.id
    UNION ALL SELECT 1 FROM parking_closures WHERE zone_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'zone with booking, rate, or closure history cannot be moved';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER parking_zone_reassignment_guard
BEFORE UPDATE OF location_id ON parking_zones
FOR EACH ROW EXECUTE FUNCTION parking_prevent_zone_reassignment();

CREATE OR REPLACE FUNCTION parking_prevent_inventory_reassignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.zone_id IS DISTINCT FROM OLD.zone_id OR NEW.category_id IS DISTINCT FROM OLD.category_id) AND EXISTS (
    SELECT 1 FROM parking_bookings WHERE inventory_id=OLD.id
    UNION ALL SELECT 1 FROM parking_closures WHERE inventory_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'inventory with booking or closure history cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER parking_inventory_reassignment_guard
BEFORE UPDATE OF zone_id, category_id ON parking_inventory
FOR EACH ROW EXECUTE FUNCTION parking_prevent_inventory_reassignment();
