-- Audited employee-created reservations and reservation-level price overrides.
-- This migration is additive: customer bookings, immutable price snapshots,
-- Stripe identifiers, inventory rules, and historical reservations are unchanged.

ALTER TABLE parking_bookings
  ADD COLUMN IF NOT EXISTS booking_source text NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS created_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS terms_acceptance_source text NOT NULL DEFAULT 'CUSTOMER';

ALTER TABLE parking_bookings
  DROP CONSTRAINT IF EXISTS parking_bookings_booking_source_check,
  DROP CONSTRAINT IF EXISTS parking_bookings_admin_source_check,
  DROP CONSTRAINT IF EXISTS parking_bookings_terms_acceptance_source_check;

ALTER TABLE parking_bookings
  ADD CONSTRAINT parking_bookings_booking_source_check
    CHECK (booking_source IN ('CUSTOMER','ADMIN_DESK')),
  ADD CONSTRAINT parking_bookings_admin_source_check CHECK (
    (booking_source='CUSTOMER' AND created_by_admin_user_id IS NULL)
    OR (booking_source='ADMIN_DESK' AND created_by_admin_user_id IS NOT NULL)
  ),
  ADD CONSTRAINT parking_bookings_terms_acceptance_source_check
    CHECK (terms_acceptance_source IN ('CUSTOMER','ADMIN_DESK'));

CREATE INDEX IF NOT EXISTS parking_bookings_admin_source_idx
  ON parking_bookings(created_by_admin_user_id,created_at DESC)
  WHERE booking_source='ADMIN_DESK';

CREATE TABLE IF NOT EXISTS parking_booking_price_overrides (
  id bigserial PRIMARY KEY,
  booking_id bigint NOT NULL REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  standard_price_cents integer NOT NULL CHECK (standard_price_cents>=0),
  final_price_cents integer NOT NULL CHECK (final_price_cents>=0),
  difference_cents integer NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  admin_user_id bigint NOT NULL REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  previous_override_id bigint REFERENCES parking_booking_price_overrides(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (difference_cents=final_price_cents-standard_price_cents)
);

CREATE INDEX IF NOT EXISTS parking_booking_price_overrides_booking_idx
  ON parking_booking_price_overrides(booking_id,created_at DESC,id DESC);

DROP TRIGGER IF EXISTS parking_booking_price_overrides_immutable ON parking_booking_price_overrides;
CREATE TRIGGER parking_booking_price_overrides_immutable
  BEFORE UPDATE OR DELETE ON parking_booking_price_overrides
  FOR EACH ROW EXECUTE FUNCTION parking_history_immutable();

