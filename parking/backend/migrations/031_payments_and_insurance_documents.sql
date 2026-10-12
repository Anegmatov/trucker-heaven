-- Payment, subscription, and private insurance-document state for the
-- term-based customer booking flow. Existing reservations are retained as
-- NOT_REQUIRED/LEGACY records; all new public Daily and Monthly flows write
-- an explicit parking product and payment state.

ALTER TABLE parking_public_quotes
  ADD COLUMN IF NOT EXISTS hold_status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS checkout_booking_id bigint UNIQUE REFERENCES parking_bookings(id) ON DELETE RESTRICT;

ALTER TABLE parking_public_quotes
  DROP CONSTRAINT IF EXISTS parking_public_quotes_hold_status_valid;
ALTER TABLE parking_public_quotes
  ADD CONSTRAINT parking_public_quotes_hold_status_valid
    CHECK (hold_status IN ('ACTIVE','RELEASED','CONSUMED','EXPIRED'));

UPDATE parking_public_quotes
SET hold_status=CASE
  WHEN consumed_booking_id IS NOT NULL THEN 'CONSUMED'
  WHEN hold_released_at IS NOT NULL THEN 'RELEASED'
  WHEN expires_at<=now() THEN 'EXPIRED'
  ELSE 'ACTIVE'
END;

ALTER TABLE parking_bookings
  ADD COLUMN IF NOT EXISTS parking_product text,
  ADD COLUMN IF NOT EXISTS payment_status text,
  ADD COLUMN IF NOT EXISTS usdot_number text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text,
  ADD COLUMN IF NOT EXISTS stripe_checkout_url text,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS stripe_latest_invoice_id text,
  ADD COLUMN IF NOT EXISTS subscription_status text,
  ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_period_end_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_grace_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkout_created_at timestamptz;

UPDATE parking_bookings
SET parking_product=CASE
      WHEN assignment_mode_snapshot='EXACT_SPOT' THEN 'LEGACY'
      WHEN COALESCE((SELECT snapshot->>'duration' FROM parking_booking_price_snapshots price WHERE price.booking_id=parking_bookings.id),'')='MONTHLY'
        THEN 'MONTHLY'
      ELSE 'DAILY'
    END,
    payment_status='NOT_REQUIRED'
WHERE parking_product IS NULL OR payment_status IS NULL;

ALTER TABLE parking_bookings
  ALTER COLUMN parking_product SET NOT NULL,
  ALTER COLUMN payment_status SET NOT NULL,
  ALTER COLUMN parking_product SET DEFAULT 'LEGACY',
  ALTER COLUMN payment_status SET DEFAULT 'NOT_REQUIRED',
  DROP CONSTRAINT IF EXISTS parking_bookings_parking_product_valid,
  DROP CONSTRAINT IF EXISTS parking_bookings_payment_status_valid,
  DROP CONSTRAINT IF EXISTS parking_bookings_usdot_number_valid;
ALTER TABLE parking_bookings
  ADD CONSTRAINT parking_bookings_parking_product_valid
    CHECK (parking_product IN ('DAILY','MONTHLY','LEGACY')),
  ADD CONSTRAINT parking_bookings_payment_status_valid
    CHECK (payment_status IN (
      'NOT_REQUIRED','DRAFT','CHECKOUT_PENDING','PAID','PAST_DUE',
      'PAYMENT_ACTION_REQUIRED','FAILED','EXPIRED','CANCELLED','REFUNDED'
    )),
  ADD CONSTRAINT parking_bookings_usdot_number_valid
    CHECK (usdot_number IS NULL OR usdot_number ~ '^[0-9]{1,12}$');

CREATE UNIQUE INDEX IF NOT EXISTS parking_bookings_stripe_checkout_session_unique
  ON parking_bookings(stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS parking_bookings_stripe_subscription_unique
  ON parking_bookings(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS parking_bookings_payment_admin_idx
  ON parking_bookings(parking_product,payment_status,billing_period_end_at);

CREATE OR REPLACE FUNCTION parking_validate_product_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parking_product='DAILY' AND NEW.assignment_mode_snapshot<>'ZONE_CAPACITY' THEN
    RAISE EXCEPTION 'new Daily parking must use zone capacity and cannot select an exact space';
  END IF;
  IF NEW.parking_product='MONTHLY' AND NEW.assignment_mode_snapshot<>'CUSTOMER_SELECTED_SPOT' THEN
    RAISE EXCEPTION 'new Monthly parking must use a customer-selected space';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parking_booking_product_assignment_valid ON parking_bookings;
CREATE TRIGGER parking_booking_product_assignment_valid
  BEFORE INSERT OR UPDATE OF parking_product,assignment_mode_snapshot ON parking_bookings
  FOR EACH ROW EXECUTE FUNCTION parking_validate_product_assignment();

CREATE TABLE IF NOT EXISTS parking_stripe_events (
  stripe_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  stripe_created_at timestamptz,
  livemode boolean NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  booking_id bigint REFERENCES parking_bookings(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS parking_customer_documents (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^doc_[A-Za-z0-9_-]{24,80}$'),
  booking_id bigint NOT NULL REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  document_type text NOT NULL CHECK (document_type IN ('VEHICLE_CARRIER_INSURANCE')),
  original_filename text NOT NULL CHECK (length(trim(original_filename)) BETWEEN 1 AND 180),
  declared_mime_type text NOT NULL,
  detected_mime_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 15728640),
  storage_provider text NOT NULL CHECK (storage_provider IN ('S3','TEST')),
  storage_bucket text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  upload_token_hash text NOT NULL UNIQUE,
  upload_expires_at timestamptz NOT NULL,
  upload_status text NOT NULL DEFAULT 'PENDING_UPLOAD'
    CHECK (upload_status IN ('PENDING_UPLOAD','UPLOADED','FAILED')),
  verification_status text NOT NULL DEFAULT 'PENDING_REVIEW'
    CHECK (verification_status IN ('PENDING_REVIEW','APPROVED','REJECTED')),
  policy_expires_at date,
  review_note text NOT NULL DEFAULT '',
  reviewed_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (uploaded_at IS NULL OR uploaded_at>=created_at),
  CHECK (reviewed_at IS NULL OR reviewed_by_admin_user_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_documents_one_current_insurance
  ON parking_customer_documents(booking_id,document_type)
  WHERE upload_status IN ('PENDING_UPLOAD','UPLOADED');
CREATE INDEX IF NOT EXISTS parking_customer_documents_admin_idx
  ON parking_customer_documents(verification_status,policy_expires_at,created_at);

CREATE TABLE IF NOT EXISTS parking_document_access_audit (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES parking_customer_documents(id) ON DELETE RESTRICT,
  admin_user_id bigint NOT NULL REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('SIGNED_READ_CREATED','APPROVED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER parking_document_access_audit_immutable
  BEFORE UPDATE OR DELETE ON parking_document_access_audit
  FOR EACH ROW EXECUTE FUNCTION parking_history_immutable();

CREATE OR REPLACE FUNCTION parking_customer_document_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at=now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER parking_customer_documents_touch
  BEFORE UPDATE ON parking_customer_documents
  FOR EACH ROW EXECUTE FUNCTION parking_customer_document_touch();
