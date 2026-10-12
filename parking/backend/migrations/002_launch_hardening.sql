ALTER TABLE parking_locations
  ADD COLUMN booking_approval_mode text NOT NULL DEFAULT 'AUTO_CONFIRM' CHECK (booking_approval_mode IN ('AUTO_CONFIRM','MANUAL_CONFIRM')),
  ADD COLUMN payment_instructions text NOT NULL DEFAULT 'Payment is due at the parking location.',
  ADD COLUMN cancellation_cutoff_hours integer NOT NULL DEFAULT 0 CHECK (cancellation_cutoff_hours >= 0);

ALTER TABLE parking_bookings ADD COLUMN idempotency_scope_hash text;
UPDATE parking_bookings SET idempotency_scope_hash = md5(lower(email)) WHERE idempotency_hash IS NOT NULL;
ALTER TABLE parking_bookings DROP CONSTRAINT IF EXISTS parking_bookings_idempotency_hash_key;
ALTER TABLE parking_bookings ADD CONSTRAINT parking_bookings_idempotency_scope_unique UNIQUE (idempotency_hash, idempotency_scope_hash);
CREATE INDEX parking_bookings_location_arrival_idx ON parking_bookings(location_id, arrival_at);
