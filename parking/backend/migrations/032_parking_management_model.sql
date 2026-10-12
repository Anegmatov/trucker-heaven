-- Parking-management model for the single Trucker Heaven lot.
--
-- This migration deliberately captures every row it changes before applying
-- the classification projection.  The companion guarded rollback script can
-- restore those values without changing physical IDs, geometry, reservations,
-- or audit history.

CREATE TABLE IF NOT EXISTS parking_management_migration_snapshots (
  migration_key text NOT NULL,
  entity_type text NOT NULL,
  entity_id bigint NOT NULL,
  before_state jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (migration_key,entity_type,entity_id)
);

CREATE TABLE IF NOT EXISTS parking_configuration_conflicts (
  id bigserial PRIMARY KEY,
  migration_key text NOT NULL,
  location_id bigint NOT NULL REFERENCES parking_locations(id) ON DELETE RESTRICT,
  parking_spot_id bigint REFERENCES parking_spots(id) ON DELETE RESTRICT,
  booking_id bigint REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  conflict_code text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  UNIQUE (migration_key,conflict_code,location_id,parking_spot_id,booking_id)
);

CREATE INDEX IF NOT EXISTS parking_configuration_conflicts_open_idx
  ON parking_configuration_conflicts(location_id,status,detected_at DESC)
  WHERE status='OPEN';

ALTER TABLE parking_admin_users
  ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

ALTER TABLE parking_admin_users
  DROP CONSTRAINT IF EXISTS parking_admin_users_display_name_valid,
  DROP CONSTRAINT IF EXISTS parking_admin_users_email_valid;
ALTER TABLE parking_admin_users
  ADD CONSTRAINT parking_admin_users_display_name_valid
    CHECK (length(display_name)<=120),
  ADD CONSTRAINT parking_admin_users_email_valid
    CHECK (email IS NULL OR email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
CREATE UNIQUE INDEX IF NOT EXISTS parking_admin_users_email_unique
  ON parking_admin_users(lower(email)) WHERE email IS NOT NULL;

ALTER TABLE parking_layout_elements
  DROP CONSTRAINT IF EXISTS parking_layout_space_purpose_valid;
ALTER TABLE parking_layout_elements
  ADD CONSTRAINT parking_layout_space_purpose_valid CHECK (
    parking_purpose IS NULL OR parking_purpose IN ('CUSTOMER','SHOP','COMPANY','INTERNAL','UNRESOLVED')
  );

ALTER TABLE parking_spots
  DROP CONSTRAINT IF EXISTS parking_spots_parking_use_check;
ALTER TABLE parking_spots
  ADD CONSTRAINT parking_spots_parking_use_check CHECK (
    parking_use IN ('CUSTOMER','DAILY','WEEKLY','MONTHLY','COMPANY','SHOP','SHOP_BOBTAIL','CUSTOMER_BOBTAIL','INTERNAL','NEEDS_CLASSIFICATION')
  );

-- Renumber previews may exchange two labels.  Deferring the existing
-- per-location uniqueness check lets the publish transaction perform that
-- exchange atomically while preserving the stable spot IDs.
ALTER TABLE parking_spots
  DROP CONSTRAINT IF EXISTS parking_spots_location_id_public_label_key;
ALTER TABLE parking_spots
  ADD CONSTRAINT parking_spots_location_id_public_label_key
    UNIQUE (location_id,public_label) DEFERRABLE INITIALLY IMMEDIATE;

-- Only canonical Trucker Heaven locations are changed.  Fixtures and any
-- unrelated locations retain their own configuration.
INSERT INTO parking_management_migration_snapshots(migration_key,entity_type,entity_id,before_state)
SELECT '032_daily_monthly_model','LOCATION',location.id,to_jsonb(location)
FROM parking_locations location
WHERE EXISTS (
  SELECT 1 FROM parking_lot_layouts layout
  WHERE layout.location_id=location.id AND layout.name LIKE 'Trucker Heaven physical lot%'
)
ON CONFLICT DO NOTHING;

INSERT INTO parking_management_migration_snapshots(migration_key,entity_type,entity_id,before_state)
SELECT '032_daily_monthly_model','ZONE',zone.id,to_jsonb(zone)
FROM parking_zones zone
WHERE EXISTS (
  SELECT 1 FROM parking_lot_layouts layout
  WHERE layout.location_id=zone.location_id AND layout.name LIKE 'Trucker Heaven physical lot%'
)
ON CONFLICT DO NOTHING;

INSERT INTO parking_management_migration_snapshots(migration_key,entity_type,entity_id,before_state)
SELECT '032_daily_monthly_model','LAYOUT_ELEMENT',element.id,to_jsonb(element)
FROM parking_layout_elements element
JOIN parking_lot_layouts layout ON layout.id=element.layout_id
WHERE layout.name LIKE 'Trucker Heaven physical lot%'
ON CONFLICT DO NOTHING;

INSERT INTO parking_management_migration_snapshots(migration_key,entity_type,entity_id,before_state)
SELECT '032_daily_monthly_model','AREA_DIRECTIONS',direction.id,to_jsonb(direction)
FROM parking_area_directions direction
WHERE EXISTS (
  SELECT 1 FROM parking_lot_layouts layout
  WHERE layout.location_id=direction.location_id AND layout.name LIKE 'Trucker Heaven physical lot%'
)
ON CONFLICT DO NOTHING;

SELECT set_config('parking.layout_publication','on',true);

UPDATE parking_locations location
SET name='Trucker Heaven Parking',version=version+1,updated_at=now()
WHERE EXISTS (
  SELECT 1 FROM parking_lot_layouts layout
  WHERE layout.location_id=location.id AND layout.name LIKE 'Trucker Heaven physical lot%'
)
  AND location.name IS DISTINCT FROM 'Trucker Heaven Parking';

-- Keep stable technical zone IDs.  The primary customer grouping receives the
-- one manager-facing area name; category-specific technical groupings remain
-- backend-only and are never presented as separate lots.
WITH primary_zone AS (
  SELECT DISTINCT ON (zone.location_id) zone.id
  FROM parking_zones zone
  JOIN parking_lot_layouts layout ON layout.location_id=zone.location_id
  WHERE layout.name LIKE 'Trucker Heaven physical lot%'
    AND zone.name IN ('General Truck Parking','Customer parking','South Zone','North Zone')
  ORDER BY zone.location_id,
    CASE zone.name WHEN 'General Truck Parking' THEN 0 WHEN 'Customer parking' THEN 1 ELSE 2 END,
    zone.id
)
UPDATE parking_zones zone
SET name='General Area',description='Parking-space organization for Trucker Heaven Parking.',version=version+1
FROM primary_zone target
WHERE zone.id=target.id AND zone.name IS DISTINCT FROM 'General Area'
  AND NOT EXISTS (
    SELECT 1 FROM parking_zones existing
    WHERE existing.location_id=zone.location_id AND existing.name='General Area' AND existing.id<>zone.id
  );

-- Customer/public space numbers 111 through 142 are Daily.  Every other
-- active customer/public space is Monthly.  Vehicle inventory and geometry are
-- intentionally untouched.
UPDATE parking_layout_elements element
SET daily_eligible=(spot.public_label::integer BETWEEN 111 AND 142),
    weekly_eligible=false,
    monthly_eligible=NOT (spot.public_label::integer BETWEEN 111 AND 142),
    space_public_bookable=true,
    version=element.version+1,
    updated_at=now()
FROM parking_spots spot
JOIN parking_lot_layouts layout ON layout.location_id=spot.location_id
WHERE element.layout_id=layout.id
  AND element.parking_spot_id=spot.id
  AND layout.name LIKE 'Trucker Heaven physical lot%'
  AND element.parking_purpose='CUSTOMER'
  AND spot.public_label ~ '^[0-9]+$'
  AND (
    element.daily_eligible IS DISTINCT FROM (spot.public_label::integer BETWEEN 111 AND 142)
    OR element.weekly_eligible
    OR element.monthly_eligible IS DISTINCT FROM NOT (spot.public_label::integer BETWEEN 111 AND 142)
    OR NOT element.space_public_bookable
  );

-- Neutral, accurate map wording and one shared driveway marker.  Existing EXIT
-- geometry, where present, is aligned with the canonical entrance; renderers
-- intentionally display the coincident pair once.
UPDATE parking_layout_elements element
SET label=CASE
      WHEN element.element_type IN ('ENTRANCE','EXIT') THEN 'Entrance / Exit'
      WHEN element.label ~* 'trucker heaven[[:space:]]+north[[:space:]]+office' THEN 'Trucker Heaven Office'
      WHEN element.label ~* 'northbound[[:space:]]+entrance' THEN 'Entrance / Exit'
      WHEN element.label ~* 'west[[:space:]]+perimeter' THEN 'Perimeter'
      ELSE element.label
    END,
    version=element.version+1,
    updated_at=now()
FROM parking_lot_layouts layout
WHERE layout.id=element.layout_id AND layout.name LIKE 'Trucker Heaven physical lot%'
  AND (element.element_type IN ('ENTRANCE','EXIT')
    OR element.label ~* '(trucker heaven[[:space:]]+north[[:space:]]+office|northbound[[:space:]]+entrance|west[[:space:]]+perimeter)');

WITH shared AS (
  SELECT layout.id layout_id,entrance.x,entrance.y,entrance.width,entrance.height,entrance.rotation
  FROM parking_lot_layouts layout
  JOIN LATERAL (
    SELECT element.x,element.y,element.width,element.height,element.rotation
    FROM parking_layout_elements element
    WHERE element.layout_id=layout.id AND element.element_type='ENTRANCE' AND element.active
    ORDER BY element.id LIMIT 1
  ) entrance ON true
  WHERE layout.name LIKE 'Trucker Heaven physical lot%'
)
UPDATE parking_layout_elements exit
SET x=shared.x,y=shared.y,width=shared.width,height=shared.height,rotation=shared.rotation,
    label='Entrance / Exit',version=exit.version+1,updated_at=now()
FROM shared
WHERE exit.layout_id=shared.layout_id AND exit.element_type='EXIT'
  AND (exit.x,exit.y,exit.width,exit.height,exit.rotation,exit.label)
    IS DISTINCT FROM (shared.x,shared.y,shared.width,shared.height,shared.rotation,'Entrance / Exit');

UPDATE parking_area_directions direction
SET exit_element_key=entrance_element_key,
    exit_route_element_keys=arrival_route_element_keys,
    version=version+1,
    updated_at=now()
WHERE EXISTS (
  SELECT 1 FROM parking_lot_layouts layout
  WHERE layout.location_id=direction.location_id AND layout.name LIKE 'Trucker Heaven physical lot%'
)
  AND entrance_element_key IS NOT NULL
  AND (exit_element_key IS DISTINCT FROM entrance_element_key
    OR exit_route_element_keys IS DISTINCT FROM arrival_route_element_keys);

-- Preserve incompatible historical/current reservations and make the issue
-- visible for owner review.  New writes remain governed by the booking-product
-- assignment trigger and server-side availability checks.
INSERT INTO parking_configuration_conflicts(
  migration_key,location_id,parking_spot_id,booking_id,conflict_code,details
)
SELECT '032_daily_monthly_model',booking.location_id,assignment.parking_spot_id,booking.id,
  'MONTHLY_RESERVATION_ON_DAILY_SPACE',
  jsonb_build_object('reservationNumber',booking.reservation_number,'space',spot.public_label,
    'arrivalAt',booking.arrival_at,'departureAt',booking.departure_at,'status',booking.status)
FROM parking_bookings booking
JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id
JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
WHERE booking.parking_product='MONTHLY'
  AND booking.status IN ('PENDING','CONFIRMED','CHECKED_IN')
  AND assignment.released_at IS NULL
  AND assignment.protected_until_at>now()
  AND spot.public_label ~ '^[0-9]+$'
  AND spot.public_label::integer BETWEEN 111 AND 142
ON CONFLICT DO NOTHING;

INSERT INTO parking_configuration_conflicts(
  migration_key,location_id,booking_id,conflict_code,details
)
SELECT '032_daily_monthly_model',booking.location_id,booking.id,
  'DAILY_RESERVATION_HAS_EXACT_SPACE',
  jsonb_build_object('reservationNumber',booking.reservation_number,'arrivalAt',booking.arrival_at,
    'departureAt',booking.departure_at,'status',booking.status)
FROM parking_bookings booking
WHERE booking.parking_product='DAILY'
  AND booking.status IN ('PENDING','CONFIRMED','CHECKED_IN')
  AND EXISTS (SELECT 1 FROM reservation_spot_assignments assignment WHERE assignment.booking_id=booking.id)
ON CONFLICT DO NOTHING;

-- Report a genuine physical anomaly without fabricating a missing space.
INSERT INTO parking_configuration_conflicts(
  migration_key,location_id,conflict_code,details
)
SELECT '032_daily_monthly_model',location.id,'DAILY_RANGE_COUNT',
  jsonb_build_object('expected',32,'actual',count(*)::int)
FROM parking_locations location
JOIN parking_spots spot ON spot.location_id=location.id
WHERE spot.active AND spot.public_bookable AND spot.public_label ~ '^[0-9]+$'
  AND spot.public_label::integer BETWEEN 111 AND 142
  AND EXISTS (
    SELECT 1 FROM parking_lot_layouts layout
    WHERE layout.location_id=location.id AND layout.name LIKE 'Trucker Heaven physical lot%'
  )
GROUP BY location.id
HAVING count(*)<>32
ON CONFLICT DO NOTHING;
