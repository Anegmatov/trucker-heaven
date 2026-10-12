CREATE OR REPLACE FUNCTION validate_layout_element_rate_plan_scope() RETURNS trigger AS $$
BEGIN
  IF NEW.rate_plan_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.inventory_id IS NULL OR NEW.parking_purpose IS DISTINCT FROM 'CUSTOMER' OR NOT EXISTS (
    SELECT 1
    FROM parking_rate_rules rule
    JOIN parking_lot_layouts layout ON layout.id=NEW.layout_id
    JOIN parking_inventory inventory ON inventory.id=NEW.inventory_id
    LEFT JOIN parking_spots spot ON spot.id=NEW.parking_spot_id
    WHERE rule.id=NEW.rate_plan_id
      AND rule.location_id=layout.location_id
      AND rule.category_id=inventory.category_id
      AND (rule.zone_id IS NULL OR rule.zone_id=COALESCE(NEW.zone_id,spot.zone_id))
  ) THEN
    RAISE EXCEPTION 'layout element rate plan must match its location, area, category, and customer purpose'
      USING ERRCODE='23514', CONSTRAINT='parking_layout_element_rate_plan_scope';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS parking_layout_element_rate_plan_scope ON parking_layout_elements;
CREATE TRIGGER parking_layout_element_rate_plan_scope
BEFORE INSERT OR UPDATE OF rate_plan_id,inventory_id,zone_id,parking_spot_id,layout_id,parking_purpose
ON parking_layout_elements
FOR EACH ROW EXECUTE FUNCTION validate_layout_element_rate_plan_scope();
