-- Short-lived, server-side authorization for the low-sensitivity customer
-- parking summary and document intake. The stronger OTP/session tables remain
-- intact for backward compatibility and are not weakened by this capability.

CREATE TABLE IF NOT EXISTS parking_customer_lookup_grants (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  booking_id bigint NOT NULL REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  document_type text CHECK (document_type IS NULL OR document_type IN ('DRIVER_LICENSE','INSURANCE')),
  requester_ip_hash text NOT NULL CHECK (requester_ip_hash ~ '^[a-f0-9]{64}$'),
  user_agent_hash text NOT NULL CHECK (user_agent_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at>created_at)
);

CREATE INDEX IF NOT EXISTS parking_customer_lookup_grants_expiry_idx
  ON parking_customer_lookup_grants(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS parking_customer_lookup_grants_booking_idx
  ON parking_customer_lookup_grants(booking_id,expires_at DESC) WHERE revoked_at IS NULL;
