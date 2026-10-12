BEGIN;

ALTER TABLE parking_bookings
  DROP CONSTRAINT IF EXISTS parking_bookings_parking_product_valid;
ALTER TABLE parking_bookings
  ADD CONSTRAINT parking_bookings_parking_product_valid
    CHECK (parking_product IN ('DAILY','WEEKLY','MONTHLY','LEGACY'));

CREATE OR REPLACE FUNCTION parking_validate_product_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parking_product IN ('DAILY','WEEKLY') AND NEW.assignment_mode_snapshot<>'ZONE_CAPACITY' THEN
    RAISE EXCEPTION 'new Daily and Weekly parking must use zone capacity and cannot select an exact space';
  END IF;
  IF NEW.parking_product='MONTHLY' AND NEW.assignment_mode_snapshot<>'CUSTOMER_SELECTED_SPOT' THEN
    RAISE EXCEPTION 'new Monthly parking must use a customer-selected space';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE parking_customer_payments
  DROP CONSTRAINT IF EXISTS parking_customer_payments_parking_product_check;
ALTER TABLE parking_customer_payments
  ADD CONSTRAINT parking_customer_payments_parking_product_check
    CHECK (parking_product IN ('DAILY','WEEKLY','MONTHLY'));

-- Current published and draft customer spaces expose the new Weekly capacity
-- product. Daily/Monthly remain the mutually exclusive canonical base term.
SELECT set_config('parking.layout_publication','on',true);

UPDATE parking_layout_elements element
SET weekly_eligible=true,version=element.version+1,updated_at=now()
FROM parking_lot_layouts layout
WHERE layout.id=element.layout_id
  AND layout.name LIKE 'Trucker Heaven physical lot · %'
  AND layout.status IN ('DRAFT','PUBLISHED')
  AND element.element_type='PARKING_SPOT'
  AND element.parking_purpose='CUSTOMER'
  AND element.space_public_bookable
  AND NOT element.weekly_eligible;

-- Rate plans are the one authoritative source consumed by availability,
-- quotes, immutable snapshots, and Stripe Checkout.
UPDATE parking_rate_rules rule
SET weekly_rate_cents=10000,
    monthly_rate_cents=CASE WHEN category.code='BOBTAIL' THEN 25000 ELSE rule.monthly_rate_cents END,
    version=rule.version+1
FROM parking_categories category
WHERE category.id=rule.category_id
  AND category.code IN ('BOBTAIL','TRACTOR_TRAILER')
  AND rule.active
  AND EXISTS (
    SELECT 1 FROM parking_layout_elements element
    JOIN parking_lot_layouts layout ON layout.id=element.layout_id
    WHERE element.rate_plan_id=rule.id
      AND layout.name LIKE 'Trucker Heaven physical lot · %'
      AND layout.status IN ('DRAFT','PUBLISHED')
  )
  AND (rule.weekly_rate_cents IS DISTINCT FROM 10000
    OR (category.code='BOBTAIL' AND rule.monthly_rate_cents IS DISTINCT FROM 25000));

COMMIT;
