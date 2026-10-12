BEGIN;

-- Customer-facing rate plans are authoritative for all newly quoted parking.
-- Keep Daily at $19 for both vehicle types while preserving the distinct
-- Standard ($250) and Bobtail ($150) recurring Monthly rates.
UPDATE parking_rate_rules rule
SET daily_rate_cents=1900,
    monthly_rate_cents=CASE category.code WHEN 'BOBTAIL' THEN 15000 ELSE 25000 END,
    version=rule.version+1
FROM parking_categories category
WHERE category.id=rule.category_id
  AND rule.active
  AND category.code IN ('BOBTAIL','TRACTOR_TRAILER')
  AND (rule.daily_rate_cents IS DISTINCT FROM 1900
    OR rule.monthly_rate_cents IS DISTINCT FROM CASE category.code WHEN 'BOBTAIL' THEN 15000 ELSE 25000 END);

COMMIT;
