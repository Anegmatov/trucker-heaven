-- A BEFORE DELETE trigger must return OLD.  Migration 016 returned NEW, which
-- is NULL for DELETE and therefore cancelled even permitted draft/test cleanup.
CREATE OR REPLACE FUNCTION parking_layout_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('parking.layout_publication', true)='on' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF OLD.status='PUBLISHED' THEN
    IF NEW.status='SUPERSEDED' AND NEW.location_id=OLD.location_id AND NEW.name=OLD.name
       AND NEW.version=OLD.version AND NEW.published_at=OLD.published_at
       AND NEW.created_by_admin_user_id=OLD.created_by_admin_user_id THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'published layout snapshots are immutable';
  END IF;
  IF OLD.status='SUPERSEDED' THEN RAISE EXCEPTION 'superseded layout snapshots are immutable'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
