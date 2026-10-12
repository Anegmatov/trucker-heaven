CREATE OR REPLACE FUNCTION parking_area_public_id() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 'pa_' || md5(random()::text || clock_timestamp()::text || txid_current()::text)
$$;

ALTER TABLE parking_zones
  ADD COLUMN IF NOT EXISTS public_id text;

UPDATE parking_zones
  SET public_id=parking_area_public_id()
  WHERE public_id IS NULL;

ALTER TABLE parking_zones
  ALTER COLUMN public_id SET DEFAULT parking_area_public_id(),
  ALTER COLUMN public_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='parking_zones_public_id_unique') THEN
    ALTER TABLE parking_zones ADD CONSTRAINT parking_zones_public_id_unique UNIQUE (public_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='parking_zones_public_id_format') THEN
    ALTER TABLE parking_zones ADD CONSTRAINT parking_zones_public_id_format CHECK (public_id ~ '^pa_[a-f0-9]{32}$');
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS parking_zones_public_customer_idx
  ON parking_zones(public_id, location_id)
  WHERE active AND public_visible;
