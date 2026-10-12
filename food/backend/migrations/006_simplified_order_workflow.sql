ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_ready_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS orders_estimated_ready_at_idx ON orders (estimated_ready_at);

CREATE OR REPLACE FUNCTION validate_order_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('CONFIRMED', 'CANCELLED')) OR
    (OLD.status = 'CONFIRMED' AND NEW.status IN ('READY', 'CANCELLED')) OR
    (OLD.status = 'PREPARING' AND NEW.status = 'READY') OR
    (OLD.status = 'READY' AND NEW.status = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'invalid order status transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
