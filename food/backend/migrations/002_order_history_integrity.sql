CREATE OR REPLACE FUNCTION validate_order_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('CONFIRMED', 'CANCELLED')) OR
    (OLD.status = 'CONFIRMED' AND NEW.status IN ('PREPARING', 'CANCELLED')) OR
    (OLD.status = 'PREPARING' AND NEW.status = 'READY') OR
    (OLD.status = 'READY' AND NEW.status = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'invalid order status transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_validate_status_transition
BEFORE UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION validate_order_status_transition();

CREATE OR REPLACE FUNCTION reject_immutable_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER order_items_append_only
BEFORE UPDATE OR DELETE ON order_items
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();

CREATE TRIGGER order_status_history_append_only
BEFORE UPDATE OR DELETE ON order_status_history
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();
