-- Daily and Weekly drivers can now pick their own numbered space on the lot map,
-- the same way Monthly drivers do. Staff-entered Daily/Weekly reservations may
-- still sell area capacity (no exact space). Monthly always holds a space.
CREATE OR REPLACE FUNCTION parking_validate_product_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parking_product IN ('DAILY','WEEKLY')
     AND NEW.assignment_mode_snapshot NOT IN ('ZONE_CAPACITY','CUSTOMER_SELECTED_SPOT') THEN
    RAISE EXCEPTION 'Daily and Weekly parking must use area capacity or a customer-selected space';
  END IF;
  IF NEW.parking_product='MONTHLY' AND NEW.assignment_mode_snapshot<>'CUSTOMER_SELECTED_SPOT' THEN
    RAISE EXCEPTION 'new Monthly parking must use a customer-selected space';
  END IF;
  RETURN NEW;
END;
$$;
