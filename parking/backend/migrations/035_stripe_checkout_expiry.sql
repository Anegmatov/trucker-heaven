-- Keep Stripe's hosted Checkout window and ParkingOps' local pending hold on
-- one explicit clock. This value is operational metadata only; payment still
-- becomes authoritative exclusively through a verified Stripe webhook.

ALTER TABLE parking_bookings
  ADD COLUMN IF NOT EXISTS stripe_checkout_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS parking_bookings_checkout_expiry_idx
  ON parking_bookings(payment_status,stripe_checkout_expires_at)
  WHERE payment_status='CHECKOUT_PENDING';
