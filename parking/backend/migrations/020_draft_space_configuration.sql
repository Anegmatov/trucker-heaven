-- Space purpose and booking eligibility belong to a layout version.  Keeping
-- the values beside the exact-space element means an owner can prepare a draft
-- without changing the layout customers or Live Lot currently read.
ALTER TABLE parking_layout_elements
  ADD COLUMN IF NOT EXISTS parking_purpose text,
  ADD COLUMN IF NOT EXISTS daily_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS weekly_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS monthly_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS space_public_bookable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS space_internal_note text NOT NULL DEFAULT '';

ALTER TABLE parking_layout_elements
  DROP CONSTRAINT IF EXISTS parking_layout_space_purpose_valid;
ALTER TABLE parking_layout_elements
  ADD CONSTRAINT parking_layout_space_purpose_valid CHECK (
    parking_purpose IS NULL OR parking_purpose IN ('CUSTOMER','SHOP','COMPANY','UNRESOLVED')
  );

ALTER TABLE parking_layout_elements
  DROP CONSTRAINT IF EXISTS parking_layout_space_booking_eligibility_valid;
ALTER TABLE parking_layout_elements
  ADD CONSTRAINT parking_layout_space_booking_eligibility_valid CHECK (
    (parking_purpose IS NULL AND NOT daily_eligible AND NOT weekly_eligible AND NOT monthly_eligible AND NOT space_public_bookable)
    OR parking_purpose IS NOT NULL
  );

-- Historical layouts are immutable in normal operation.  This one-time
-- projection is a schema upgrade, not an owner edit, so it runs under the
-- existing publication guard.
SELECT set_config('parking.layout_publication','on',true);
UPDATE parking_layout_elements e
SET parking_purpose=CASE
      WHEN s.parking_use IN ('SHOP','SHOP_BOBTAIL') THEN 'SHOP'
      WHEN s.parking_use='COMPANY' THEN 'COMPANY'
      WHEN s.parking_use='NEEDS_CLASSIFICATION' THEN 'UNRESOLVED'
      ELSE 'CUSTOMER'
    END,
    daily_eligible=CASE WHEN s.public_bookable AND s.classification_state='COMPLETE' THEN true ELSE false END,
    weekly_eligible=CASE WHEN s.public_bookable AND s.classification_state='COMPLETE' THEN true ELSE false END,
    monthly_eligible=false,
    space_public_bookable=CASE WHEN s.public_bookable AND s.classification_state='COMPLETE' THEN true ELSE false END,
    space_internal_note=s.internal_notes
FROM parking_spots s
WHERE e.parking_spot_id=s.id;

-- The confirmed physical review leaves 73–80 unresolved.  They remain on the
-- canonical map for operations but are never customer-visible or assignable.
UPDATE parking_layout_elements e
SET parking_purpose='UNRESOLVED',daily_eligible=false,weekly_eligible=false,
    monthly_eligible=false,space_public_bookable=false
FROM parking_spots s
WHERE e.parking_spot_id=s.id AND s.public_label ~ '^[0-9]+$'
  AND s.public_label::integer BETWEEN 73 AND 80;
