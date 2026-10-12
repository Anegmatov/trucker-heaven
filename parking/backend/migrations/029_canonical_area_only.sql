-- Trucker Heaven customer reservations are permanently capacity reservations
-- inside a highlighted parking area. Numbered spaces remain the authoritative
-- physical inventory and historical exact assignments remain untouched.
UPDATE parking_locations location
SET assignment_mode='ZONE_CAPACITY',
    exact_mode_active=false,
    physical_layout_confirmed_at=NULL,
    physical_layout_confirmed_by_admin_user_id=NULL,
    version=version+1,
    updated_at=now()
WHERE EXISTS (
    SELECT 1 FROM parking_lot_layouts layout
    WHERE layout.location_id=location.id
      AND layout.status='PUBLISHED'
      AND layout.name LIKE 'Trucker Heaven physical lot%'
  )
  AND (assignment_mode IS DISTINCT FROM 'ZONE_CAPACITY' OR exact_mode_active);

CREATE OR REPLACE FUNCTION parking_canonical_area_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('parking.real_lot_rollback',true),'')<>'on'
    AND (NEW.assignment_mode='EXACT_SPOT' OR NEW.exact_mode_active)
    AND EXISTS (
      SELECT 1 FROM parking_lot_layouts layout
      WHERE layout.location_id=NEW.id
        AND layout.status='PUBLISHED'
        AND layout.name LIKE 'Trucker Heaven physical lot%'
    ) THEN
    RAISE EXCEPTION 'canonical Trucker Heaven customer parking must use ZONE_CAPACITY'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parking_canonical_area_assignment_guard_trigger ON parking_locations;
CREATE TRIGGER parking_canonical_area_assignment_guard_trigger
  BEFORE UPDATE OF assignment_mode,exact_mode_active ON parking_locations
  FOR EACH ROW EXECUTE FUNCTION parking_canonical_area_assignment_guard();

CREATE OR REPLACE FUNCTION parking_canonical_layout_enforce_area_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='PUBLISHED' AND NEW.name LIKE 'Trucker Heaven physical lot%' THEN
    UPDATE parking_locations
    SET assignment_mode='ZONE_CAPACITY',
        exact_mode_active=false,
        physical_layout_confirmed_at=NULL,
        physical_layout_confirmed_by_admin_user_id=NULL,
        version=version+1,
        updated_at=now()
    WHERE id=NEW.location_id
      AND (assignment_mode IS DISTINCT FROM 'ZONE_CAPACITY' OR exact_mode_active);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parking_canonical_layout_enforce_area_assignment_insert_trigger ON parking_lot_layouts;
CREATE TRIGGER parking_canonical_layout_enforce_area_assignment_insert_trigger
  AFTER INSERT ON parking_lot_layouts
  FOR EACH ROW EXECUTE FUNCTION parking_canonical_layout_enforce_area_assignment();

DROP TRIGGER IF EXISTS parking_canonical_layout_enforce_area_assignment_update_trigger ON parking_lot_layouts;
CREATE TRIGGER parking_canonical_layout_enforce_area_assignment_update_trigger
  AFTER UPDATE OF status,name ON parking_lot_layouts
  FOR EACH ROW EXECUTE FUNCTION parking_canonical_layout_enforce_area_assignment();
