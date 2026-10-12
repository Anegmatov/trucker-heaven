-- Correct the confirmed public contact details for the canonical Trucker
-- Heaven parking property. The update is intentionally guarded by the
-- canonical published-layout relationship, the verified street-address
-- prefix, and the exact stale phone value observed in production.
--
-- Capture every affected row first so the correction remains reversible
-- without guessing at the prior production value.

INSERT INTO parking_management_migration_snapshots (
  migration_key,
  entity_type,
  entity_id,
  before_state
)
SELECT
  '037_canonical_location_contact_correction',
  'LOCATION',
  location.id,
  to_jsonb(location)
FROM parking_locations location
WHERE EXISTS (
  SELECT 1
  FROM parking_lot_layouts layout
  WHERE layout.location_id = location.id
    AND layout.name LIKE 'Trucker Heaven physical lot%'
)
AND (
  (
    location.address LIKE '8037 Eastgate Blvd, Mt. Juliet, TN 37122%'
    AND location.address <> '8037 Eastgate Blvd, Mt. Juliet, TN 37122'
  )
  OR regexp_replace(COALESCE(location.phone, ''), '[^0-9]', '', 'g') = '6623706230'
)
ON CONFLICT DO NOTHING;

UPDATE parking_locations location
SET
  address = CASE
    WHEN location.address LIKE '8037 Eastgate Blvd, Mt. Juliet, TN 37122%'
      THEN '8037 Eastgate Blvd, Mt. Juliet, TN 37122'
    ELSE location.address
  END,
  phone = CASE
    WHEN regexp_replace(COALESCE(location.phone, ''), '[^0-9]', '', 'g') = '6623706230'
      THEN '+16154705075'
    ELSE location.phone
  END,
  version = location.version + 1,
  updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM parking_lot_layouts layout
  WHERE layout.location_id = location.id
    AND layout.name LIKE 'Trucker Heaven physical lot%'
)
AND (
  (
    location.address LIKE '8037 Eastgate Blvd, Mt. Juliet, TN 37122%'
    AND location.address <> '8037 Eastgate Blvd, Mt. Juliet, TN 37122'
  )
  OR regexp_replace(COALESCE(location.phone, ''), '[^0-9]', '', 'g') = '6623706230'
);
