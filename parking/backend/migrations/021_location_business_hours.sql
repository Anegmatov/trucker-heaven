-- Keep business hours separate from the street address without changing any
-- existing property values. Owners may populate this optional field later.
ALTER TABLE parking_locations
  ADD COLUMN IF NOT EXISTS business_hours text NOT NULL DEFAULT '';
