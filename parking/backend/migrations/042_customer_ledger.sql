-- Canonical parking-customer ledger and audited legacy import support.
-- Existing reservations, Stripe identifiers, documents, and customer identity
-- grants remain authoritative and are not rewritten by this migration.

CREATE TABLE IF NOT EXISTS parking_customer_import_batches (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^imp_[A-Za-z0-9_-]{24,80}$'),
  source_filename text NOT NULL CHECK (length(trim(source_filename)) BETWEEN 1 AND 260),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_sheet text NOT NULL CHECK (length(trim(source_sheet)) BETWEEN 1 AND 160),
  status text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  initiated_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  initiated_by text NOT NULL CHECK (length(trim(initiated_by)) BETWEEN 1 AND 160),
  rows_considered integer NOT NULL DEFAULT 0 CHECK (rows_considered>=0),
  records_created integer NOT NULL DEFAULT 0 CHECK (records_created>=0),
  records_matched integer NOT NULL DEFAULT 0 CHECK (records_matched>=0),
  conflicts integer NOT NULL DEFAULT 0 CHECK (conflicts>=0),
  errors integer NOT NULL DEFAULT 0 CHECK (errors>=0),
  summary jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(source_sha256,source_sheet)
);

ALTER TABLE parking_customers
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS usdot_number text,
  ADD COLUMN IF NOT EXISTS mc_number text,
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS record_source text NOT NULL DEFAULT 'PARKINGOPS',
  ADD COLUMN IF NOT EXISTS legacy_import_batch_id bigint REFERENCES parking_customer_import_batches(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS legacy_source_ref text,
  ADD COLUMN IF NOT EXISTS legacy_parking_type text,
  ADD COLUMN IF NOT EXISTS legacy_current_spot text,
  ADD COLUMN IF NOT EXISTS legacy_rate_cents integer,
  ADD COLUMN IF NOT EXISTS imported_at timestamptz;

UPDATE parking_customers
SET display_name=concat_ws(' ',first_name,last_name)
WHERE display_name IS NULL;

UPDATE parking_customers customer
SET company_name=COALESCE(customer.company_name,(
      SELECT booking.company_name FROM parking_bookings booking
      WHERE booking.customer_id=customer.id AND booking.company_name IS NOT NULL
      ORDER BY booking.created_at DESC,booking.id DESC LIMIT 1)),
    usdot_number=COALESCE(customer.usdot_number,(
      SELECT booking.usdot_number FROM parking_bookings booking
      WHERE booking.customer_id=customer.id AND booking.usdot_number IS NOT NULL
      ORDER BY booking.created_at DESC,booking.id DESC LIMIT 1))
WHERE customer.company_name IS NULL OR customer.usdot_number IS NULL;

ALTER TABLE parking_customers
  ALTER COLUMN first_name DROP NOT NULL,
  ALTER COLUMN last_name DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS parking_customers_first_name_check,
  DROP CONSTRAINT IF EXISTS parking_customers_last_name_check,
  DROP CONSTRAINT IF EXISTS parking_customers_check,
  DROP CONSTRAINT IF EXISTS parking_customers_status_check,
  DROP CONSTRAINT IF EXISTS parking_customers_lifecycle_status_check,
  DROP CONSTRAINT IF EXISTS parking_customers_record_source_check,
  DROP CONSTRAINT IF EXISTS parking_customers_source_integrity_check,
  DROP CONSTRAINT IF EXISTS parking_customers_usdot_number_check,
  DROP CONSTRAINT IF EXISTS parking_customers_mc_number_check,
  DROP CONSTRAINT IF EXISTS parking_customers_legacy_parking_type_check,
  DROP CONSTRAINT IF EXISTS parking_customers_legacy_rate_cents_check;

ALTER TABLE parking_customers
  ADD CONSTRAINT parking_customers_status_check
    CHECK (status IN ('PENDING','ACTIVE','RECOVERY_REQUIRED','SUSPENDED')),
  ADD CONSTRAINT parking_customers_name_check CHECK (
    (first_name IS NOT NULL AND length(trim(first_name)) BETWEEN 1 AND 80
      AND last_name IS NOT NULL AND length(trim(last_name)) BETWEEN 1 AND 80)
    OR (company_name IS NOT NULL AND length(trim(company_name)) BETWEEN 1 AND 160)
    OR (display_name IS NOT NULL AND length(trim(display_name)) BETWEEN 1 AND 160)
  ),
  ADD CONSTRAINT parking_customers_contact_or_legacy_check CHECK (
    normalized_phone IS NOT NULL OR normalized_email IS NOT NULL OR record_source='LEGACY_EXCEL_IMPORT'
  ),
  ADD CONSTRAINT parking_customers_lifecycle_status_check CHECK (lifecycle_status IN ('ACTIVE','FORMER')),
  ADD CONSTRAINT parking_customers_record_source_check CHECK (record_source IN ('PARKINGOPS','LEGACY_EXCEL_IMPORT')),
  ADD CONSTRAINT parking_customers_source_integrity_check CHECK (
    (record_source='PARKINGOPS' AND legacy_import_batch_id IS NULL AND legacy_source_ref IS NULL AND imported_at IS NULL)
    OR (record_source='LEGACY_EXCEL_IMPORT' AND legacy_import_batch_id IS NOT NULL
      AND legacy_source_ref IS NOT NULL AND imported_at IS NOT NULL)
  ),
  ADD CONSTRAINT parking_customers_usdot_number_check CHECK (usdot_number IS NULL OR usdot_number ~ '^[0-9]{1,12}$'),
  ADD CONSTRAINT parking_customers_mc_number_check CHECK (mc_number IS NULL OR mc_number ~ '^[0-9]{1,12}$'),
  ADD CONSTRAINT parking_customers_legacy_parking_type_check CHECK (legacy_parking_type IS NULL OR legacy_parking_type IN ('DAILY','MONTHLY','IN_PERSON')),
  ADD CONSTRAINT parking_customers_legacy_rate_cents_check CHECK (legacy_rate_cents IS NULL OR legacy_rate_cents>=0);

CREATE INDEX IF NOT EXISTS parking_customers_display_name_search_idx ON parking_customers(lower(display_name));
CREATE INDEX IF NOT EXISTS parking_customers_company_search_idx ON parking_customers(lower(company_name)) WHERE company_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS parking_customers_usdot_search_idx ON parking_customers(usdot_number) WHERE usdot_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS parking_customers_mc_search_idx ON parking_customers(mc_number) WHERE mc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS parking_customers_lifecycle_idx ON parking_customers(lifecycle_status,created_at DESC);

ALTER TABLE parking_customer_vehicles
  ADD COLUMN IF NOT EXISTS vehicle_description text,
  ADD COLUMN IF NOT EXISTS record_source text NOT NULL DEFAULT 'PARKINGOPS',
  ADD COLUMN IF NOT EXISTS legacy_import_batch_id bigint REFERENCES parking_customer_import_batches(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS legacy_source_ref text,
  ALTER COLUMN unit_number DROP NOT NULL,
  ALTER COLUMN license_plate DROP NOT NULL,
  ALTER COLUMN license_plate_state DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS parking_customer_vehicles_unit_number_check,
  DROP CONSTRAINT IF EXISTS parking_customer_vehicles_license_plate_check,
  DROP CONSTRAINT IF EXISTS parking_customer_vehicles_license_plate_state_check,
  DROP CONSTRAINT IF EXISTS parking_customer_vehicles_record_source_check,
  DROP CONSTRAINT IF EXISTS parking_customer_vehicles_source_integrity_check;

ALTER TABLE parking_customer_vehicles
  ADD CONSTRAINT parking_customer_vehicles_unit_number_check CHECK (unit_number IS NULL OR length(trim(unit_number)) BETWEEN 1 AND 80),
  ADD CONSTRAINT parking_customer_vehicles_license_plate_check CHECK (license_plate IS NULL OR length(trim(license_plate)) BETWEEN 1 AND 30),
  ADD CONSTRAINT parking_customer_vehicles_license_plate_state_check CHECK (license_plate_state IS NULL OR length(trim(license_plate_state)) BETWEEN 1 AND 40),
  ADD CONSTRAINT parking_customer_vehicles_identity_check CHECK (unit_number IS NOT NULL OR license_plate IS NOT NULL OR vehicle_description IS NOT NULL),
  ADD CONSTRAINT parking_customer_vehicles_record_source_check CHECK (record_source IN ('PARKINGOPS','LEGACY_EXCEL_IMPORT')),
  ADD CONSTRAINT parking_customer_vehicles_source_integrity_check CHECK (
    (record_source='PARKINGOPS' AND legacy_import_batch_id IS NULL AND legacy_source_ref IS NULL)
    OR (record_source='LEGACY_EXCEL_IMPORT' AND legacy_import_batch_id IS NOT NULL AND legacy_source_ref IS NOT NULL)
  );

DROP INDEX IF EXISTS parking_customer_vehicle_identity_unique;
CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_vehicle_identity_unique
  ON parking_customer_vehicles(customer_id,upper(license_plate),upper(license_plate_state))
  WHERE license_plate IS NOT NULL AND license_plate_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS parking_customer_vehicle_plate_search_idx
  ON parking_customer_vehicles((regexp_replace(upper(license_plate),'[^A-Z0-9]','','g')))
  WHERE license_plate IS NOT NULL;
CREATE INDEX IF NOT EXISTS parking_customer_vehicle_unit_search_idx
  ON parking_customer_vehicles(lower(unit_number)) WHERE unit_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS parking_customer_billing_periods (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^bill_[A-Za-z0-9_-]{24,80}$'),
  customer_id bigint NOT NULL REFERENCES parking_customers(id) ON DELETE RESTRICT,
  booking_id bigint REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  period_start date NOT NULL CHECK (period_start=date_trunc('month',period_start)::date),
  amount_due_cents integer NOT NULL CHECK (amount_due_cents>=0),
  due_date date NOT NULL,
  currency text NOT NULL DEFAULT 'usd' CHECK (currency ~ '^[a-z]{3}$'),
  source text NOT NULL CHECK (source IN ('BOOKING','STRIPE','LEGACY_EXCEL_IMPORT','ADMIN')),
  legacy_confidence text CHECK (legacy_confidence IS NULL OR legacy_confidence IN ('EXACT_AMOUNT','EXACT_STATUS_ONLY')),
  legacy_import_batch_id bigint REFERENCES parking_customer_import_batches(id) ON DELETE RESTRICT,
  legacy_source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (source<>'LEGACY_EXCEL_IMPORT' AND legacy_confidence IS NULL
      AND legacy_import_batch_id IS NULL AND legacy_source_ref IS NULL)
    OR (source='LEGACY_EXCEL_IMPORT' AND legacy_confidence IS NOT NULL
      AND legacy_import_batch_id IS NOT NULL AND legacy_source_ref IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_billing_booking_period_unique
  ON parking_customer_billing_periods(customer_id,booking_id,period_start) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_billing_legacy_period_unique
  ON parking_customer_billing_periods(customer_id,period_start) WHERE booking_id IS NULL;
CREATE INDEX IF NOT EXISTS parking_customer_billing_period_idx
  ON parking_customer_billing_periods(period_start,due_date,customer_id);
CREATE INDEX IF NOT EXISTS parking_customer_billing_customer_idx
  ON parking_customer_billing_periods(customer_id,period_start DESC);

ALTER TABLE parking_customer_payments
  ADD COLUMN IF NOT EXISTS billing_period_id bigint REFERENCES parking_customer_billing_periods(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS payment_source text NOT NULL DEFAULT 'STRIPE',
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'CARD',
  ADD COLUMN IF NOT EXISTS payment_date date,
  ADD COLUMN IF NOT EXISTS payment_date_precision text NOT NULL DEFAULT 'EXACT',
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS created_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS legacy_confidence text,
  ADD COLUMN IF NOT EXISTS legacy_import_batch_id bigint REFERENCES parking_customer_import_batches(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS legacy_source_ref text,
  ALTER COLUMN booking_id DROP NOT NULL,
  ALTER COLUMN processor DROP NOT NULL,
  ALTER COLUMN processor_payment_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS parking_customer_payments_processor_check,
  DROP CONSTRAINT IF EXISTS parking_customer_payments_payment_source_check,
  DROP CONSTRAINT IF EXISTS parking_customer_payments_payment_method_check,
  DROP CONSTRAINT IF EXISTS parking_customer_payments_payment_date_precision_check,
  DROP CONSTRAINT IF EXISTS parking_customer_payments_legacy_confidence_check,
  DROP CONSTRAINT IF EXISTS parking_customer_payments_source_integrity_check;

UPDATE parking_customer_payments
SET payment_date=COALESCE(paid_at::date,created_at::date),
    payment_source='STRIPE',payment_method='CARD'
WHERE payment_date IS NULL;

ALTER TABLE parking_customer_payments
  ALTER COLUMN payment_date SET NOT NULL,
  ALTER COLUMN payment_date SET DEFAULT current_date,
  ADD CONSTRAINT parking_customer_payments_payment_source_check CHECK (payment_source IN ('STRIPE','LEGACY_EXCEL_IMPORT','ADMIN_MANUAL')),
  ADD CONSTRAINT parking_customer_payments_payment_method_check CHECK (payment_method IN ('CARD','CASH','CLOVER','CHECK','OTHER','LEGACY')),
  ADD CONSTRAINT parking_customer_payments_payment_date_precision_check CHECK (payment_date_precision IN ('EXACT','PERIOD_ONLY')),
  ADD CONSTRAINT parking_customer_payments_legacy_confidence_check CHECK (legacy_confidence IS NULL OR legacy_confidence IN ('EXACT_AMOUNT','EXACT_STATUS_ONLY')),
  ADD CONSTRAINT parking_customer_payments_source_integrity_check CHECK (
    (payment_source='STRIPE' AND processor='STRIPE' AND processor_payment_id IS NOT NULL AND booking_id IS NOT NULL
      AND created_by_admin_user_id IS NULL AND legacy_import_batch_id IS NULL)
    OR (payment_source='ADMIN_MANUAL' AND processor IS NULL AND processor_payment_id IS NULL
      AND created_by_admin_user_id IS NOT NULL AND legacy_import_batch_id IS NULL)
    OR (payment_source='LEGACY_EXCEL_IMPORT' AND processor IS NULL AND processor_payment_id IS NULL
      AND legacy_import_batch_id IS NOT NULL AND legacy_confidence IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS parking_customer_payments_period_idx
  ON parking_customer_payments(billing_period_id,payment_date,id) WHERE billing_period_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS parking_customer_payments_status_date_idx
  ON parking_customer_payments(status,payment_date DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_payments_legacy_source_unique
  ON parking_customer_payments(legacy_import_batch_id,legacy_source_ref)
  WHERE legacy_import_batch_id IS NOT NULL AND legacy_source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS parking_customer_payment_adjustments (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^adj_[A-Za-z0-9_-]{24,80}$'),
  payment_id bigint NOT NULL REFERENCES parking_customer_payments(id) ON DELETE RESTRICT,
  billing_period_id bigint NOT NULL REFERENCES parking_customer_billing_periods(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents<>0),
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('CORRECTION','REVERSAL')),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by_admin_user_id bigint NOT NULL REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parking_customer_payment_adjustments_payment_idx
  ON parking_customer_payment_adjustments(payment_id,created_at,id);

CREATE TABLE IF NOT EXISTS parking_customer_notes (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^note_[A-Za-z0-9_-]{24,80}$'),
  customer_id bigint NOT NULL REFERENCES parking_customers(id) ON DELETE RESTRICT,
  note text NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 4000),
  follow_up_date date,
  resolved_at timestamptz,
  resolved_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  created_by_admin_user_id bigint REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  legacy_import_batch_id bigint REFERENCES parking_customer_import_batches(id) ON DELETE RESTRICT,
  legacy_source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((resolved_at IS NULL AND resolved_by_admin_user_id IS NULL)
    OR (resolved_at IS NOT NULL AND resolved_by_admin_user_id IS NOT NULL)),
  CHECK (
    (created_by_admin_user_id IS NOT NULL AND legacy_import_batch_id IS NULL AND legacy_source_ref IS NULL)
    OR (created_by_admin_user_id IS NULL AND legacy_import_batch_id IS NOT NULL AND legacy_source_ref IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS parking_customer_notes_customer_idx
  ON parking_customer_notes(customer_id,resolved_at NULLS FIRST,follow_up_date,created_at DESC);

CREATE TABLE IF NOT EXISTS parking_customer_import_rows (
  id bigserial PRIMARY KEY,
  import_batch_id bigint NOT NULL REFERENCES parking_customer_import_batches(id) ON DELETE RESTRICT,
  source_row integer NOT NULL CHECK (source_row>0),
  classification text NOT NULL CHECK (classification IN ('MATCH_EXISTING','NEW_CUSTOMER','AMBIGUOUS','INVALID','NON_CUSTOMER')),
  matched_customer_id bigint REFERENCES parking_customers(id) ON DELETE RESTRICT,
  reason text NOT NULL DEFAULT '',
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  proposed_record jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_batch_id,source_row)
);
CREATE INDEX IF NOT EXISTS parking_customer_import_rows_classification_idx
  ON parking_customer_import_rows(import_batch_id,classification,source_row);

INSERT INTO parking_customer_billing_periods(
  public_id,customer_id,booking_id,period_start,amount_due_cents,due_date,currency,source)
SELECT 'bill_'||md5(payment.customer_id::text||':'||payment.booking_id::text||':'||
    date_trunc('month',COALESCE(payment.paid_at,payment.created_at))::date::text),
  payment.customer_id,payment.booking_id,date_trunc('month',COALESCE(payment.paid_at,payment.created_at))::date,
  max(payment.amount_cents),date_trunc('month',COALESCE(payment.paid_at,payment.created_at))::date,
  min(payment.currency),'STRIPE'
FROM parking_customer_payments payment
WHERE payment.parking_product='MONTHLY' AND payment.booking_id IS NOT NULL
GROUP BY payment.customer_id,payment.booking_id,date_trunc('month',COALESCE(payment.paid_at,payment.created_at))::date
ON CONFLICT DO NOTHING;

UPDATE parking_customer_payments payment
SET billing_period_id=period.id
FROM parking_customer_billing_periods period
WHERE payment.billing_period_id IS NULL AND payment.parking_product='MONTHLY'
  AND period.customer_id=payment.customer_id AND period.booking_id=payment.booking_id
  AND period.period_start=date_trunc('month',COALESCE(payment.paid_at,payment.created_at))::date;

CREATE OR REPLACE VIEW parking_customer_billing_period_balances AS
SELECT period.id,period.public_id,period.customer_id,period.booking_id,period.period_start,
  period.amount_due_cents,period.due_date,period.currency,period.source,period.legacy_confidence,
  COALESCE(payment.paid_cents,0)::bigint paid_cents,
  GREATEST(period.amount_due_cents-COALESCE(payment.paid_cents,0),0)::bigint balance_cents,
  GREATEST(COALESCE(payment.paid_cents,0)-period.amount_due_cents,0)::bigint credit_cents,
  CASE
    WHEN period.amount_due_cents=0 THEN 'NOT_DUE'
    WHEN COALESCE(payment.paid_cents,0)>=period.amount_due_cents THEN 'PAID'
    WHEN COALESCE(payment.paid_cents,0)>0 THEN 'PARTIAL'
    WHEN period.due_date<current_date THEN 'OVERDUE'
    ELSE 'DUE'
  END status,
  period.created_at,period.updated_at
FROM parking_customer_billing_periods period
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(base.amount_cents),0)+COALESCE(sum(base.adjustment_cents),0) paid_cents
  FROM (
    SELECT payment.amount_cents::bigint,COALESCE(sum(adjustment.amount_cents),0)::bigint adjustment_cents
    FROM parking_customer_payments payment
    LEFT JOIN parking_customer_payment_adjustments adjustment ON adjustment.payment_id=payment.id
    WHERE payment.billing_period_id=period.id AND payment.status='PAID'
    GROUP BY payment.id,payment.amount_cents
  ) base
) payment ON true;

CREATE OR REPLACE FUNCTION prevent_customer_financial_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Customer financial audit records are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS parking_customer_payment_adjustments_immutable ON parking_customer_payment_adjustments;
CREATE TRIGGER parking_customer_payment_adjustments_immutable
  BEFORE UPDATE OR DELETE ON parking_customer_payment_adjustments
  FOR EACH ROW EXECUTE FUNCTION prevent_customer_financial_audit_mutation();

DROP TRIGGER IF EXISTS parking_customer_import_rows_immutable ON parking_customer_import_rows;
CREATE TRIGGER parking_customer_import_rows_immutable
  BEFORE UPDATE OR DELETE ON parking_customer_import_rows
  FOR EACH ROW EXECUTE FUNCTION prevent_customer_financial_audit_mutation();
