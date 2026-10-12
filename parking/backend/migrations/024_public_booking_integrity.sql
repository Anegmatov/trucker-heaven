ALTER TABLE parking_bookings
  ADD COLUMN IF NOT EXISTS idempotency_request_hash text;

CREATE TABLE IF NOT EXISTS parking_public_quotes (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  location_id bigint NOT NULL REFERENCES parking_locations(id),
  inventory_id bigint NOT NULL REFERENCES parking_inventory(id),
  parking_spot_id bigint REFERENCES parking_spots(id),
  rate_rule_id bigint NOT NULL REFERENCES parking_rate_rules(id),
  arrival_at timestamptz NOT NULL,
  departure_at timestamptz NOT NULL,
  pricing_snapshot jsonb NOT NULL,
  rate_basis_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_booking_id bigint UNIQUE REFERENCES parking_bookings(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (departure_at > arrival_at),
  CHECK (jsonb_typeof(pricing_snapshot)='object')
);

CREATE INDEX IF NOT EXISTS parking_public_quotes_expiry_idx
  ON parking_public_quotes(expires_at) WHERE consumed_booking_id IS NULL;

CREATE OR REPLACE FUNCTION prevent_parking_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'parking audit records are immutable' USING ERRCODE='55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS parking_audit_events_immutable ON parking_audit_events;
CREATE TRIGGER parking_audit_events_immutable
BEFORE UPDATE OR DELETE ON parking_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_parking_audit_mutation();
