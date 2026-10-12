-- A rate rule is already a reusable, versioned price definition.  Give it an
-- owner-facing plan name and let each layout-space reference one instead of
-- duplicating dollar amounts across the physical 185-space map.
ALTER TABLE parking_rate_rules
  ADD COLUMN IF NOT EXISTS plan_name text NOT NULL DEFAULT '';

ALTER TABLE parking_rate_rules
  DROP CONSTRAINT IF EXISTS parking_rate_rules_plan_name_valid;
ALTER TABLE parking_rate_rules
  ADD CONSTRAINT parking_rate_rules_plan_name_valid
    CHECK (length(trim(plan_name)) <= 120);

ALTER TABLE parking_layout_elements
  ADD COLUMN IF NOT EXISTS rate_plan_id bigint REFERENCES parking_rate_rules(id);

ALTER TABLE parking_layout_elements
  DROP CONSTRAINT IF EXISTS parking_layout_elements_rate_plan_customer_only;
ALTER TABLE parking_layout_elements
  ADD CONSTRAINT parking_layout_elements_rate_plan_customer_only
    CHECK (rate_plan_id IS NULL OR parking_purpose='CUSTOMER');

CREATE INDEX IF NOT EXISTS parking_layout_elements_rate_plan_idx
  ON parking_layout_elements(rate_plan_id) WHERE rate_plan_id IS NOT NULL;

-- Existing nonempty rule definitions remain authoritative.  Give them the
-- concise owner-facing name only when a prior name is absent.
UPDATE parking_rate_rules
SET plan_name=CASE
  WHEN plan_name<>'' THEN plan_name
  WHEN category_id IN (SELECT id FROM parking_categories WHERE code IN ('BOBTAIL','TRACTOR_TRAILER')) THEN 'Standard Parking'
  ELSE 'Parking rate plan'
END
WHERE plan_name='';

-- The standard customer plan is created only for a physical-lot/category pair
-- that has no active rule at all.  Existing fee and tax behavior is preserved;
-- a brand-new category receives the schema's zero-fee/zero-tax defaults.
INSERT INTO parking_rate_rules(location_id,zone_id,category_id,plan_name,daily_rate_cents,weekly_rate_cents,monthly_rate_cents,fee_cents,tax_basis_points,priority,active)
SELECT location.id,NULL,category.id,'Standard Parking',1900,NULL,25000,0,0,0,true
FROM parking_locations location
JOIN parking_lot_layouts layout ON layout.location_id=location.id AND layout.status='PUBLISHED'
JOIN parking_categories category ON category.code IN ('BOBTAIL','TRACTOR_TRAILER') AND category.active
WHERE NOT EXISTS (
  SELECT 1 FROM parking_rate_rules rule
  WHERE rule.location_id=location.id AND rule.category_id=category.id AND rule.active
);

-- This schema projection is part of the migration, not an owner map edit.
-- It prefers an existing zone-specific rate, then the broader active rate, and
-- leaves any explicit future assignment untouched.
SELECT set_config('parking.layout_publication','on',true);
WITH matched_plans AS (
  SELECT element.id element_id, plan.id plan_id
  FROM parking_layout_elements element
  JOIN parking_lot_layouts layout ON layout.id=element.layout_id
  JOIN parking_spots spot ON spot.id=element.parking_spot_id
  JOIN parking_inventory inventory ON inventory.id=spot.inventory_id
  JOIN LATERAL (
    SELECT rule.id
    FROM parking_rate_rules rule
    WHERE rule.location_id=spot.location_id AND rule.category_id=inventory.category_id AND rule.active
      AND (rule.starts_at IS NULL OR rule.starts_at<=now())
      AND (rule.ends_at IS NULL OR rule.ends_at>now())
      AND (rule.zone_id IS NULL OR rule.zone_id=spot.zone_id)
    ORDER BY (rule.zone_id IS NOT NULL) DESC, rule.priority DESC, rule.id DESC
    LIMIT 1
  ) plan ON true
  WHERE element.rate_plan_id IS NULL AND element.active AND element.space_public_bookable
    AND element.parking_purpose='CUSTOMER' AND spot.classification_state='COMPLETE'
)
UPDATE parking_layout_elements element
SET rate_plan_id=matched_plans.plan_id
FROM matched_plans
WHERE element.id=matched_plans.element_id;
