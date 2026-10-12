ALTER TABLE parking_booking_status_history
  ADD CONSTRAINT parking_status_history_version_unique UNIQUE (booking_id, version),
  ADD CONSTRAINT parking_status_history_new_status_check CHECK (new_status IN ('PENDING','CONFIRMED','CHECKED_IN','CHECKED_OUT','COMPLETED','CANCELLED','NO_SHOW','EXPIRED')),
  ADD CONSTRAINT parking_status_history_previous_status_check CHECK (previous_status IS NULL OR previous_status IN ('PENDING','CONFIRMED','CHECKED_IN','CHECKED_OUT','COMPLETED','CANCELLED','NO_SHOW','EXPIRED'));

CREATE OR REPLACE FUNCTION parking_booking_status_requires_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM parking_booking_status_history
    WHERE booking_id=NEW.id AND version=NEW.version AND new_status=NEW.status AND previous_status=OLD.status
  ) THEN
    RAISE EXCEPTION 'booking status update requires matching immutable history';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER parking_booking_status_history_required
AFTER UPDATE OF status ON parking_bookings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION parking_booking_status_requires_history();
