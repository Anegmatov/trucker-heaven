CREATE OR REPLACE FUNCTION parking_location_public_id() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 'pl_' || md5(random()::text || clock_timestamp()::text || txid_current()::text)
$$;

ALTER TABLE parking_locations
  ADD COLUMN public_id text NOT NULL DEFAULT parking_location_public_id();
ALTER TABLE parking_locations
  ADD CONSTRAINT parking_locations_public_id_unique UNIQUE (public_id),
  ADD CONSTRAINT parking_locations_public_id_format CHECK (public_id ~ '^pl_[a-f0-9]{32}$');

ALTER TABLE parking_bookings ADD COLUMN pending_expires_at timestamptz;
UPDATE parking_bookings
  SET pending_expires_at=created_at + interval '30 minutes'
  WHERE status='PENDING' AND pending_expires_at IS NULL;
CREATE INDEX parking_pending_expiry_idx
  ON parking_bookings(pending_expires_at) WHERE status='PENDING';
