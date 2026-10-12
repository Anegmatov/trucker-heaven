-- Durable metadata for the physical Trucker Heaven map.  Operational state stays
-- in assignments/blocks; these columns describe the space even when it is empty.
ALTER TABLE parking_spots
  ADD COLUMN IF NOT EXISTS physical_section text NOT NULL DEFAULT 'UNASSIGNED'
    CHECK (length(trim(physical_section)) BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS parking_use text NOT NULL DEFAULT 'NEEDS_CLASSIFICATION'
    CHECK (parking_use IN ('CUSTOMER','DAILY','WEEKLY','MONTHLY','COMPANY','SHOP','SHOP_BOBTAIL','CUSTOMER_BOBTAIL','NEEDS_CLASSIFICATION')),
  ADD COLUMN IF NOT EXISTS public_bookable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS classification_state text NOT NULL DEFAULT 'NEEDS_CLASSIFICATION'
    CHECK (classification_state IN ('COMPLETE','NEEDS_CLASSIFICATION')),
  ADD COLUMN IF NOT EXISTS operational_label text NOT NULL DEFAULT ''
    CHECK (length(operational_label) <= 160);

ALTER TABLE parking_spots
  DROP CONSTRAINT IF EXISTS parking_spots_public_bookable_classified;
ALTER TABLE parking_spots
  ADD CONSTRAINT parking_spots_public_bookable_classified
    CHECK (NOT public_bookable OR (classification_state='COMPLETE' AND parking_use<>'NEEDS_CLASSIFICATION'));

CREATE INDEX IF NOT EXISTS parking_spots_real_lot_classification_idx
  ON parking_spots(location_id,active,public_bookable,classification_state,parking_use,physical_section);
