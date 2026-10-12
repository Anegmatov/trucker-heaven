-- Vehicle-type changes can move a space between the General and Bobtail
-- inventories. Keep that zone/inventory change private in the draft until the
-- publication transaction updates the operational parking_spots row.
CREATE OR REPLACE FUNCTION parking_validate_layout_element_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  layout_location_id bigint;
  layout_state text;
  linked_spot parking_spots%ROWTYPE;
  publishing boolean := COALESCE(current_setting('parking.layout_publication',true),'')='on';
BEGIN
  SELECT location_id,status INTO layout_location_id,layout_state FROM parking_lot_layouts WHERE id=NEW.layout_id;
  IF layout_location_id IS NULL THEN RAISE EXCEPTION 'layout does not exist'; END IF;
  IF NEW.zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM parking_zones WHERE id=NEW.zone_id AND location_id=layout_location_id
  ) THEN RAISE EXCEPTION 'layout zone must belong to the layout location'; END IF;
  IF NEW.inventory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM parking_inventory i JOIN parking_zones z ON z.id=i.zone_id
    WHERE i.id=NEW.inventory_id AND z.location_id=layout_location_id
  ) THEN RAISE EXCEPTION 'layout inventory must belong to the layout location'; END IF;
  IF NEW.parking_spot_id IS NOT NULL THEN
    SELECT * INTO linked_spot FROM parking_spots WHERE id=NEW.parking_spot_id;
    IF linked_spot.id IS NULL OR linked_spot.location_id<>layout_location_id
      OR (layout_state<>'DRAFT' AND NOT publishing AND linked_spot.zone_id IS DISTINCT FROM NEW.zone_id)
      OR (layout_state<>'DRAFT' AND NOT publishing AND linked_spot.inventory_id IS DISTINCT FROM NEW.inventory_id)
      OR linked_spot.visual_element_key<>NEW.element_key
      OR NEW.element_type<>'PARKING_SPOT' THEN
      RAISE EXCEPTION 'layout parking spot link is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
