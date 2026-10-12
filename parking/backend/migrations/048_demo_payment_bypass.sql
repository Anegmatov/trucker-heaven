BEGIN;

ALTER TABLE parking_bookings
  DROP CONSTRAINT IF EXISTS parking_bookings_payment_status_valid;
ALTER TABLE parking_bookings
  ADD CONSTRAINT parking_bookings_payment_status_valid
    CHECK (payment_status IN (
      'NOT_REQUIRED','DRAFT','CHECKOUT_PENDING','PAID','DEMO_BYPASSED','PAST_DUE',
      'PAYMENT_ACTION_REQUIRED','FAILED','EXPIRED','CANCELLED','REFUNDED'
    ));

ALTER TABLE parking_customer_notification_outbox
  DROP CONSTRAINT IF EXISTS parking_customer_notification_outbox_event_type_check;
ALTER TABLE parking_customer_notification_outbox
  ADD CONSTRAINT parking_customer_notification_outbox_event_type_check
    CHECK (event_type IN (
      'RESERVATION_CONFIRMED','DEMO_RESERVATION_CONFIRMED','MONTHLY_RENEWED','MONTHLY_PAYMENT_FAILED',
      'CANCELLATION_CONFIRMED','INSURANCE_DOCUMENT_ISSUE','DOCUMENT_REPLACEMENT_REQUESTED',
      'ADMIN_RESERVATION_CREATED','ADMIN_PAYMENT_LINK_CREATED'
    ));

CREATE TABLE parking_demo_payment_grants (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^demo_[A-Za-z0-9_-]{24,80}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  booking_id bigint NOT NULL REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  customer_id bigint NOT NULL REFERENCES parking_customers(id) ON DELETE RESTRICT,
  created_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  initiator text NOT NULL CHECK (initiator IN ('ADMIN','CLI')),
  reason text NOT NULL DEFAULT 'DEMO_QA' CHECK (reason='DEMO_QA'),
  price_snapshot jsonb NOT NULL CHECK (jsonb_typeof(price_snapshot)='object'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  invalidated_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at>created_at),
  CHECK (used_at IS NULL OR used_at>=created_at),
  CHECK (completed_at IS NULL OR used_at IS NOT NULL),
  CHECK (NOT (used_at IS NOT NULL AND invalidated_at IS NOT NULL))
);

CREATE INDEX parking_demo_payment_grants_booking_idx
  ON parking_demo_payment_grants(booking_id,created_at DESC);
CREATE INDEX parking_demo_payment_grants_expiry_idx
  ON parking_demo_payment_grants(expires_at)
  WHERE used_at IS NULL AND invalidated_at IS NULL;
CREATE UNIQUE INDEX parking_demo_payment_grants_one_open_per_booking
  ON parking_demo_payment_grants(booking_id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE FUNCTION parking_demo_payment_grant_binding_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.public_id,NEW.token_hash,NEW.booking_id,NEW.customer_id,
      NEW.created_by_admin_user_id,NEW.initiator,NEW.reason,NEW.price_snapshot,
      NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.public_id,OLD.token_hash,OLD.booking_id,OLD.customer_id,
      OLD.created_by_admin_user_id,OLD.initiator,OLD.reason,OLD.price_snapshot,
      OLD.expires_at,OLD.created_at) THEN
    RAISE EXCEPTION 'Demo payment authorization binding and audit fields are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER parking_demo_payment_grants_binding_immutable
  BEFORE UPDATE ON parking_demo_payment_grants
  FOR EACH ROW EXECUTE FUNCTION parking_demo_payment_grant_binding_immutable();

CREATE TRIGGER parking_demo_payment_grants_immutable
  BEFORE DELETE ON parking_demo_payment_grants
  FOR EACH ROW EXECUTE FUNCTION parking_history_immutable();

COMMIT;
