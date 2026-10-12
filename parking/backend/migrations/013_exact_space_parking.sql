CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION parking_element_key() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 'le_' || md5(random()::text || clock_timestamp()::text || txid_current()::text)
$$;

ALTER TABLE parking_locations
  ADD COLUMN assignment_mode text NOT NULL DEFAULT 'ZONE_CAPACITY'
    CHECK (assignment_mode IN ('ZONE_CAPACITY','EXACT_SPOT')),
  ADD COLUMN exact_mode_active boolean NOT NULL DEFAULT false,
  ADD COLUMN self_service_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN road_directions_url text NOT NULL DEFAULT '',
  ADD COLUMN exit_instructions text NOT NULL DEFAULT '',
  ADD COLUMN check_in_early_minutes integer NOT NULL DEFAULT 120
    CHECK (check_in_early_minutes BETWEEN 0 AND 10080),
  ADD COLUMN check_in_late_minutes integer NOT NULL DEFAULT 1440
    CHECK (check_in_late_minutes BETWEEN 0 AND 10080),
  ADD COLUMN turnaround_buffer_minutes integer NOT NULL DEFAULT 0
    CHECK (turnaround_buffer_minutes BETWEEN 0 AND 1440),
  ADD COLUMN physical_layout_confirmed_at timestamptz,
  ADD COLUMN physical_layout_confirmed_by_admin_user_id bigint
    REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT parking_exact_mode_requires_assignment_mode
    CHECK (NOT exact_mode_active OR assignment_mode='EXACT_SPOT');

ALTER TABLE parking_zones
  ADD COLUMN arrival_directions text NOT NULL DEFAULT '',
  ADD COLUMN exit_directions text NOT NULL DEFAULT '',
  ADD COLUMN display_order integer NOT NULL DEFAULT 0;

ALTER TABLE parking_layout_elements
  ADD COLUMN element_key text NOT NULL DEFAULT parking_element_key()
    CHECK (element_key ~ '^le_[a-f0-9]{32}$');
CREATE UNIQUE INDEX parking_layout_elements_key_unique
  ON parking_layout_elements(layout_id,element_key);

CREATE TABLE parking_spots (
  id bigserial PRIMARY KEY,
  location_id bigint NOT NULL REFERENCES parking_locations(id) ON DELETE RESTRICT,
  zone_id bigint NOT NULL REFERENCES parking_zones(id) ON DELETE RESTRICT,
  inventory_id bigint NOT NULL REFERENCES parking_inventory(id) ON DELETE RESTRICT,
  public_label text NOT NULL CHECK (length(trim(public_label)) BETWEEN 1 AND 80),
  display_order integer NOT NULL DEFAULT 0,
  generated_group_key text,
  visual_element_key text NOT NULL CHECK (visual_element_key ~ '^le_[a-f0-9]{32}$'),
  active boolean NOT NULL DEFAULT true,
  internal_notes text NOT NULL DEFAULT '',
  length_feet numeric(7,2) CHECK (length_feet IS NULL OR length_feet > 0),
  width_feet numeric(7,2) CHECK (width_feet IS NULL OR width_feet > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(location_id,public_label),
  UNIQUE(location_id,visual_element_key)
);

ALTER TABLE parking_layout_elements
  ADD COLUMN parking_spot_id bigint REFERENCES parking_spots(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX parking_layout_elements_one_spot_per_layout
  ON parking_layout_elements(layout_id,parking_spot_id)
  WHERE parking_spot_id IS NOT NULL;

CREATE TABLE parking_spot_blocks (
  id bigserial PRIMARY KEY,
  parking_spot_id bigint NOT NULL REFERENCES parking_spots(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 300),
  public_message text NOT NULL DEFAULT '',
  internal_note text NOT NULL DEFAULT '',
  created_by_admin_user_id bigint NOT NULL REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (released_at IS NULL OR released_at >= created_at)
);
CREATE INDEX parking_spot_blocks_overlap_idx
  ON parking_spot_blocks(parking_spot_id,starts_at,ends_at)
  WHERE released_at IS NULL;

CREATE TABLE reservation_spot_assignments (
  id bigserial PRIMARY KEY,
  booking_id bigint NOT NULL REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  parking_spot_id bigint NOT NULL REFERENCES parking_spots(id) ON DELETE RESTRICT,
  reserved_arrival_at timestamptz NOT NULL,
  reserved_departure_at timestamptz NOT NULL,
  protected_until_at timestamptz NOT NULL,
  reserved_period tstzrange GENERATED ALWAYS AS
    (tstzrange(reserved_arrival_at,protected_until_at,'[)')) STORED,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assignment_source text NOT NULL
    CHECK (assignment_source IN ('CUSTOMER_AUTO','ADMIN_REASSIGN','SYSTEM')),
  assigned_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  assignment_reason text NOT NULL DEFAULT '',
  previous_assignment_id bigint REFERENCES reservation_spot_assignments(id) ON DELETE RESTRICT,
  released_at timestamptz,
  release_reason text,
  actual_check_in_at timestamptz,
  actual_check_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved_departure_at > reserved_arrival_at),
  CHECK (protected_until_at >= reserved_departure_at),
  CHECK (actual_check_out_at IS NULL OR actual_check_in_at IS NOT NULL),
  CHECK (actual_check_out_at IS NULL OR actual_check_out_at >= actual_check_in_at),
  EXCLUDE USING gist (parking_spot_id WITH =, reserved_period WITH &&)
    WHERE (released_at IS NULL)
);
CREATE UNIQUE INDEX reservation_spot_assignments_one_current
  ON reservation_spot_assignments(booking_id) WHERE released_at IS NULL;
CREATE INDEX reservation_spot_assignments_booking_history_idx
  ON reservation_spot_assignments(booking_id,assigned_at,id);

CREATE TABLE parking_area_directions (
  id bigserial PRIMARY KEY,
  location_id bigint NOT NULL REFERENCES parking_locations(id) ON DELETE RESTRICT,
  zone_id bigint NOT NULL UNIQUE REFERENCES parking_zones(id) ON DELETE RESTRICT,
  entrance_element_key text,
  exit_element_key text,
  arrival_route_element_keys text[] NOT NULL DEFAULT '{}',
  exit_route_element_keys text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_admin_user_id bigint NOT NULL REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION parking_validate_spot_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM parking_inventory i
    JOIN parking_zones z ON z.id=i.zone_id
    WHERE i.id=NEW.inventory_id AND z.id=NEW.zone_id
      AND z.location_id=NEW.location_id
  ) THEN
    RAISE EXCEPTION 'parking spot inventory, area, and location must belong together';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER parking_spot_relationships_valid
BEFORE INSERT OR UPDATE OF location_id,zone_id,inventory_id ON parking_spots
FOR EACH ROW EXECUTE FUNCTION parking_validate_spot_relationships();

CREATE OR REPLACE FUNCTION parking_validate_area_directions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM parking_zones WHERE id=NEW.zone_id AND location_id=NEW.location_id
  ) THEN
    RAISE EXCEPTION 'parking area directions must belong to the same location';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER parking_area_directions_relationships_valid
BEFORE INSERT OR UPDATE OF location_id,zone_id ON parking_area_directions
FOR EACH ROW EXECUTE FUNCTION parking_validate_area_directions();

CREATE OR REPLACE FUNCTION parking_validate_layout_element_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  layout_location_id bigint;
  linked_spot parking_spots%ROWTYPE;
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
  IF NEW.parking_spot_id IS NOT NULL THEN
    SELECT * INTO linked_spot FROM parking_spots WHERE id=NEW.parking_spot_id;
    IF linked_spot.id IS NULL OR linked_spot.location_id<>layout_location_id
      OR linked_spot.zone_id IS DISTINCT FROM NEW.zone_id
      OR linked_spot.inventory_id IS DISTINCT FROM NEW.inventory_id
      OR linked_spot.visual_element_key<>NEW.element_key
      OR NEW.element_type<>'PARKING_SPOT' THEN
      RAISE EXCEPTION 'layout parking spot link is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION parking_assignment_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM parking_bookings b JOIN parking_spots s ON s.id=NEW.parking_spot_id
    WHERE b.id=NEW.booking_id AND b.location_id=s.location_id
      AND b.inventory_id=s.inventory_id AND b.category_id=(SELECT category_id FROM parking_inventory WHERE id=s.inventory_id)
      AND b.arrival_at=NEW.reserved_arrival_at AND b.departure_at=NEW.reserved_departure_at
  ) THEN
    RAISE EXCEPTION 'spot assignment does not match the booking location, inventory, category, or interval';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER parking_assignment_relationships_valid
BEFORE INSERT OR UPDATE OF booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at
ON reservation_spot_assignments
FOR EACH ROW EXECUTE FUNCTION parking_assignment_relationships();

CREATE OR REPLACE FUNCTION parking_assignment_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'parking assignment history is immutable'; END;
$$;
CREATE TRIGGER reservation_spot_assignment_no_delete
BEFORE DELETE ON reservation_spot_assignments
FOR EACH ROW EXECUTE FUNCTION parking_assignment_no_delete();

CREATE TRIGGER parking_spots_touch_updated_at
BEFORE UPDATE ON parking_spots
FOR EACH ROW EXECUTE FUNCTION parking_layout_touch_updated_at();
CREATE TRIGGER parking_area_directions_touch_updated_at
BEFORE UPDATE ON parking_area_directions
FOR EACH ROW EXECUTE FUNCTION parking_layout_touch_updated_at();

CREATE INDEX parking_spots_inventory_order_idx
  ON parking_spots(inventory_id,active,display_order,public_label,id);
