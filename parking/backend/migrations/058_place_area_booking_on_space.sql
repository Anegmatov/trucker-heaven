-- Daily and Weekly drivers book the area (no numbered space). When they arrive, staff place them on a
-- space from the Live Lot. That turns the reservation into a numbered-space reservation, which is the one
-- change the immutable-snapshot rule now allows: ZONE_CAPACITY -> CUSTOMER_SELECTED_SPOT.
CREATE OR REPLACE FUNCTION parking_assignment_mode_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignment_mode_snapshot IS DISTINCT FROM OLD.assignment_mode_snapshot
     AND NOT (OLD.assignment_mode_snapshot='ZONE_CAPACITY' AND NEW.assignment_mode_snapshot='CUSTOMER_SELECTED_SPOT') THEN
    RAISE EXCEPTION 'booking assignment mode snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
