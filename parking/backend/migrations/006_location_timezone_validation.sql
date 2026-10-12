CREATE OR REPLACE FUNCTION parking_validate_location_timezone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN
    RAISE EXCEPTION 'invalid IANA timezone: %', NEW.timezone;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER parking_location_timezone_valid
BEFORE INSERT OR UPDATE OF timezone ON parking_locations
FOR EACH ROW EXECUTE FUNCTION parking_validate_location_timezone();
