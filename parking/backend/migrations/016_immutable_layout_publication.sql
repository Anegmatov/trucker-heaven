-- Immutable layout snapshots: one current publication plus durable history.
ALTER TABLE parking_lot_layouts ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE parking_lot_layouts ADD COLUMN IF NOT EXISTS superseded_by_layout_id bigint REFERENCES parking_lot_layouts(id) ON DELETE RESTRICT;

DO $$
DECLARE old_check text;
BEGIN
  SELECT conname INTO old_check FROM pg_constraint
   WHERE conrelid='parking_lot_layouts'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%status%PUBLISHED%';
  IF old_check IS NOT NULL THEN EXECUTE format('ALTER TABLE parking_lot_layouts DROP CONSTRAINT %I', old_check); END IF;
END $$;

ALTER TABLE parking_lot_layouts ADD CONSTRAINT parking_lot_layouts_lifecycle_check
  CHECK ((status='DRAFT' AND published_at IS NULL AND superseded_at IS NULL AND superseded_by_layout_id IS NULL)
      OR (status='PUBLISHED' AND published_at IS NOT NULL AND superseded_at IS NULL AND superseded_by_layout_id IS NULL)
      OR (status='SUPERSEDED' AND published_at IS NOT NULL AND superseded_at IS NOT NULL AND superseded_by_layout_id IS NOT NULL));

CREATE OR REPLACE FUNCTION parking_layout_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('parking.layout_publication', true)='on' THEN RETURN NEW; END IF;
  IF OLD.status='PUBLISHED' THEN
    IF NEW.status='SUPERSEDED' AND NEW.location_id=OLD.location_id AND NEW.name=OLD.name
       AND NEW.version=OLD.version AND NEW.published_at=OLD.published_at
       AND NEW.created_by_admin_user_id=OLD.created_by_admin_user_id THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'published layout snapshots are immutable';
  END IF;
  IF OLD.status='SUPERSEDED' THEN RAISE EXCEPTION 'superseded layout snapshots are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION parking_historical_layout_elements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lifecycle text;
BEGIN
  SELECT status INTO lifecycle FROM parking_lot_layouts WHERE id=COALESCE(NEW.layout_id,OLD.layout_id);
  IF lifecycle<>'DRAFT' AND current_setting('parking.layout_publication', true)<>'on' THEN
    RAISE EXCEPTION 'published and superseded layout elements are immutable';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

DROP TRIGGER IF EXISTS aaa_parking_layout_history_immutable ON parking_lot_layouts;
CREATE TRIGGER aaa_parking_layout_history_immutable BEFORE UPDATE OR DELETE ON parking_lot_layouts
  FOR EACH ROW EXECUTE FUNCTION parking_layout_history_immutable();
DROP TRIGGER IF EXISTS aaa_parking_historical_layout_elements_immutable ON parking_layout_elements;
CREATE TRIGGER aaa_parking_historical_layout_elements_immutable BEFORE INSERT OR UPDATE OR DELETE ON parking_layout_elements
  FOR EACH ROW EXECUTE FUNCTION parking_historical_layout_elements_immutable();
