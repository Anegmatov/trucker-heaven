CREATE TABLE parking_booking_price_adjustments (
  id bigserial PRIMARY KEY,
  booking_id bigint NOT NULL REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('DISCOUNT','MANUAL_ADJUSTMENT','ADDITIONAL_CHARGE')),
  amount_cents integer NOT NULL CHECK (amount_cents <> 0),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  admin_user_id bigint NOT NULL REFERENCES parking_admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (adjustment_type='DISCOUNT' AND amount_cents<0)
    OR (adjustment_type='ADDITIONAL_CHARGE' AND amount_cents>0)
    OR adjustment_type='MANUAL_ADJUSTMENT'
  )
);
CREATE INDEX parking_booking_price_adjustments_booking_idx
  ON parking_booking_price_adjustments(booking_id, created_at);
CREATE TRIGGER parking_price_adjustment_no_change
BEFORE UPDATE OR DELETE ON parking_booking_price_adjustments
FOR EACH ROW EXECUTE FUNCTION parking_history_immutable();

ALTER TABLE parking_bookings
  ADD COLUMN check_in_policy_acknowledged_at timestamptz,
  ADD COLUMN check_in_condition_note text NOT NULL DEFAULT '';
