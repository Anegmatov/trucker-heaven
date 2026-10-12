CREATE TABLE parking_lot_layouts (
  id bigserial PRIMARY KEY,
  location_id bigint NOT NULL REFERENCES parking_locations(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_by_admin_user_id bigint NOT NULL REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  updated_by_admin_user_id bigint NOT NULL REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  CHECK ((status='DRAFT' AND published_at IS NULL) OR (status='PUBLISHED' AND published_at IS NOT NULL))
);

CREATE UNIQUE INDEX parking_lot_layouts_one_draft_per_location
  ON parking_lot_layouts(location_id) WHERE status='DRAFT';
CREATE UNIQUE INDEX parking_lot_layouts_one_published_per_location
  ON parking_lot_layouts(location_id) WHERE status='PUBLISHED';

CREATE TABLE parking_layout_elements (
  id bigserial PRIMARY KEY,
  layout_id bigint NOT NULL REFERENCES parking_lot_layouts(id) ON DELETE CASCADE,
  element_type text NOT NULL CHECK (element_type ~ '^[A-Z][A-Z0-9_]{1,62}$'),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 240),
  zone_id bigint REFERENCES parking_zones(id) ON DELETE RESTRICT,
  inventory_id bigint REFERENCES parking_inventory(id) ON DELETE RESTRICT,
  x numeric(7,4) NOT NULL CHECK (x >= 0 AND x <= 100),
  y numeric(7,4) NOT NULL CHECK (y >= 0 AND y <= 100),
  width numeric(7,4) NOT NULL CHECK (width > 0 AND width <= 100),
  height numeric(7,4) NOT NULL CHECK (height > 0 AND height <= 100),
  rotation numeric(7,4) NOT NULL DEFAULT 0 CHECK (rotation >= -360 AND rotation <= 360),
  layer_order integer NOT NULL DEFAULT 0,
  public_visible boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (x + width <= 100 AND y + height <= 100)
);

CREATE INDEX parking_layout_elements_layout_idx ON parking_layout_elements(layout_id, layer_order, id);

CREATE OR REPLACE FUNCTION parking_validate_layout_element_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  layout_location_id bigint;
BEGIN
  SELECT location_id INTO layout_location_id FROM parking_lot_layouts WHERE id=NEW.layout_id;
  IF layout_location_id IS NULL THEN RAISE EXCEPTION 'layout does not exist'; END IF;
  IF NEW.zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM parking_zones WHERE id=NEW.zone_id AND location_id=layout_location_id
  ) THEN RAISE EXCEPTION 'layout zone must belong to the layout location'; END IF;
  IF NEW.inventory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM parking_inventory i JOIN parking_zones z ON z.id=i.zone_id
    WHERE i.id=NEW.inventory_id AND z.location_id=layout_location_id
  ) THEN RAISE EXCEPTION 'layout inventory must belong to the layout location'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER parking_layout_element_relationships_valid
BEFORE INSERT OR UPDATE OF layout_id,zone_id,inventory_id ON parking_layout_elements
FOR EACH ROW EXECUTE FUNCTION parking_validate_layout_element_relationships();

CREATE OR REPLACE FUNCTION parking_layout_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END;
$$;

CREATE TRIGGER parking_lot_layouts_touch_updated_at
BEFORE UPDATE ON parking_lot_layouts
FOR EACH ROW EXECUTE FUNCTION parking_layout_touch_updated_at();
CREATE TRIGGER parking_layout_elements_touch_updated_at
BEFORE UPDATE ON parking_layout_elements
FOR EACH ROW EXECUTE FUNCTION parking_layout_touch_updated_at();

CREATE OR REPLACE FUNCTION parking_prevent_zone_reassignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id AND EXISTS (
    SELECT 1 FROM parking_inventory i JOIN parking_bookings b ON b.inventory_id=i.id WHERE i.zone_id=OLD.id
    UNION ALL SELECT 1 FROM parking_rate_rules WHERE zone_id=OLD.id
    UNION ALL SELECT 1 FROM parking_closures WHERE zone_id=OLD.id
    UNION ALL SELECT 1 FROM parking_layout_elements WHERE zone_id=OLD.id
    UNION ALL SELECT 1 FROM parking_layout_elements e JOIN parking_inventory i ON i.id=e.inventory_id WHERE i.zone_id=OLD.id
  ) THEN RAISE EXCEPTION 'zone with operational or layout history cannot be moved'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION parking_prevent_inventory_reassignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.zone_id IS DISTINCT FROM OLD.zone_id OR NEW.category_id IS DISTINCT FROM OLD.category_id) AND EXISTS (
    SELECT 1 FROM parking_bookings WHERE inventory_id=OLD.id
    UNION ALL SELECT 1 FROM parking_closures WHERE inventory_id=OLD.id
    UNION ALL SELECT 1 FROM parking_layout_elements WHERE inventory_id=OLD.id
  ) THEN RAISE EXCEPTION 'inventory with operational or layout history cannot be reassigned'; END IF;
  RETURN NEW;
END;
$$;
