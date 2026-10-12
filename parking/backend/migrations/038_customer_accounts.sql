-- Canonical customer identities and passwordless My Parking access. Historical
-- bookings are deliberately not guessed into accounts: they can be claimed
-- later only with both an authenticated customer session and the reservation's
-- existing lookup credential.

CREATE TABLE IF NOT EXISTS parking_customers (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^cust_[A-Za-z0-9_-]{24,80}$'),
  first_name text NOT NULL CHECK (length(trim(first_name)) BETWEEN 1 AND 80),
  last_name text NOT NULL CHECK (length(trim(last_name)) BETWEEN 1 AND 80),
  normalized_phone text CHECK (normalized_phone IS NULL OR normalized_phone ~ '^\+[1-9][0-9]{7,14}$'),
  display_phone text,
  normalized_email text CHECK (normalized_email IS NULL OR normalized_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  display_email text,
  phone_verified_at timestamptz,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACTIVE','RECOVERY_REQUIRED','SUSPENDED')),
  stripe_customer_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (normalized_phone IS NOT NULL OR normalized_email IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS parking_customers_phone_unique
  ON parking_customers(normalized_phone) WHERE normalized_phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS parking_customers_email_unique
  ON parking_customers(normalized_email) WHERE normalized_email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS parking_customers_stripe_unique
  ON parking_customers(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

ALTER TABLE parking_bookings
  ADD COLUMN IF NOT EXISTS customer_id bigint REFERENCES parking_customers(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS parking_bookings_customer_timeline_idx
  ON parking_bookings(customer_id,arrival_at DESC,id DESC) WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS parking_customer_vehicles (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^veh_[A-Za-z0-9_-]{24,80}$'),
  customer_id bigint NOT NULL REFERENCES parking_customers(id) ON DELETE CASCADE,
  unit_number text NOT NULL CHECK (length(trim(unit_number)) BETWEEN 1 AND 80),
  license_plate text NOT NULL CHECK (length(trim(license_plate)) BETWEEN 1 AND 30),
  license_plate_state text NOT NULL CHECK (length(trim(license_plate_state)) BETWEEN 1 AND 40),
  vehicle_classification text NOT NULL CHECK (vehicle_classification IN ('BOBTAIL','GENERAL')),
  active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_vehicle_identity_unique
  ON parking_customer_vehicles(customer_id,upper(license_plate),upper(license_plate_state));

CREATE TABLE IF NOT EXISTS parking_customer_auth_challenges (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^otp_[A-Za-z0-9_-]{24,80}$'),
  customer_id bigint REFERENCES parking_customers(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  identifier_hash text NOT NULL CHECK (identifier_hash ~ '^[a-f0-9]{64}$'),
  masked_destination text NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  attempts_remaining integer NOT NULL CHECK (attempts_remaining BETWEEN 0 AND 20),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  delivery_status text NOT NULL DEFAULT 'PENDING'
    CHECK (delivery_status IN ('PENDING','SENT','SUPPRESSED','FAILED')),
  requester_ip_hash text NOT NULL CHECK (requester_ip_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parking_customer_auth_identifier_rate_idx
  ON parking_customer_auth_challenges(identifier_hash,created_at DESC);
CREATE INDEX IF NOT EXISTS parking_customer_auth_expiry_idx
  ON parking_customer_auth_challenges(expires_at) WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS parking_customer_sessions (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES parking_customers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  requester_ip_hash text NOT NULL CHECK (requester_ip_hash ~ '^[a-f0-9]{64}$'),
  user_agent_hash text NOT NULL CHECK (user_agent_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (idle_expires_at<=expires_at)
);
CREATE INDEX IF NOT EXISTS parking_customer_sessions_customer_idx
  ON parking_customer_sessions(customer_id,expires_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS parking_customer_payments (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^pay_[A-Za-z0-9_-]{24,80}$'),
  customer_id bigint NOT NULL REFERENCES parking_customers(id) ON DELETE RESTRICT,
  booking_id bigint NOT NULL REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  processor text NOT NULL DEFAULT 'STRIPE' CHECK (processor='STRIPE'),
  processor_payment_id text NOT NULL,
  parking_product text NOT NULL CHECK (parking_product IN ('DAILY','MONTHLY')),
  amount_cents integer NOT NULL CHECK (amount_cents>=0),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  status text NOT NULL CHECK (status IN ('PAID','FAILED','REFUNDED')),
  receipt_url text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(processor,processor_payment_id)
);
CREATE INDEX IF NOT EXISTS parking_customer_payments_customer_idx
  ON parking_customer_payments(customer_id,created_at DESC);

CREATE TABLE IF NOT EXISTS parking_customer_identity_conflicts (
  id bigserial PRIMARY KEY,
  phone_customer_id bigint NOT NULL REFERENCES parking_customers(id) ON DELETE RESTRICT,
  email_customer_id bigint NOT NULL REFERENCES parking_customers(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DISMISSED','RESOLVED')),
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count>0),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  resolution_note text NOT NULL DEFAULT '',
  CHECK (phone_customer_id<>email_customer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_identity_conflict_open_unique
  ON parking_customer_identity_conflicts(phone_customer_id,email_customer_id) WHERE status='OPEN';

CREATE TABLE IF NOT EXISTS parking_customer_notification_outbox (
  id bigserial PRIMARY KEY,
  customer_id bigint REFERENCES parking_customers(id) ON DELETE RESTRICT,
  booking_id bigint REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN (
    'RESERVATION_CONFIRMED','MONTHLY_RENEWED','MONTHLY_PAYMENT_FAILED',
    'CANCELLATION_CONFIRMED','INSURANCE_DOCUMENT_ISSUE'
  )),
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  destination text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parking_customer_notification_dispatch_idx
  ON parking_customer_notification_outbox(next_attempt_at,id) WHERE status='PENDING';

CREATE OR REPLACE FUNCTION parking_customer_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at=now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parking_customers_touch ON parking_customers;
CREATE TRIGGER parking_customers_touch BEFORE UPDATE ON parking_customers
  FOR EACH ROW EXECUTE FUNCTION parking_customer_touch();
DROP TRIGGER IF EXISTS parking_customer_vehicles_touch ON parking_customer_vehicles;
CREATE TRIGGER parking_customer_vehicles_touch BEFORE UPDATE ON parking_customer_vehicles
  FOR EACH ROW EXECUTE FUNCTION parking_customer_touch();
DROP TRIGGER IF EXISTS parking_customer_payments_touch ON parking_customer_payments;
CREATE TRIGGER parking_customer_payments_touch BEFORE UPDATE ON parking_customer_payments
  FOR EACH ROW EXECUTE FUNCTION parking_customer_touch();
