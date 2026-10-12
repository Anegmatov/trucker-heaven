-- current_setting(..., true) is NULL when the publication flag is absent;
-- coalesce it so ordinary sessions cannot mutate historical elements.
CREATE OR REPLACE FUNCTION parking_historical_layout_elements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lifecycle text;
BEGIN
  SELECT status INTO lifecycle FROM parking_lot_layouts WHERE id=COALESCE(NEW.layout_id,OLD.layout_id);
  IF lifecycle<>'DRAFT' AND COALESCE(current_setting('parking.layout_publication', true),'')<>'on' THEN
    RAISE EXCEPTION 'published and superseded layout elements are immutable';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
