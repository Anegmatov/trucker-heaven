-- Quote price/scope/selection fields remain immutable. Checkout timing is a
-- separate lifecycle field so a Stripe Session can safely keep its original
-- quote or selected-space hold until the hosted payment window closes.

ALTER TABLE parking_public_quotes
  ADD COLUMN IF NOT EXISTS checkout_hold_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS parking_public_quotes_checkout_hold_expiry_idx
  ON parking_public_quotes(COALESCE(checkout_hold_expires_at,expires_at))
  WHERE assignment_mode='CUSTOMER_SELECTED_SPOT'
    AND consumed_booking_id IS NULL
    AND hold_released_at IS NULL;
