-- Safe multi-space legacy customer import.  Carrier authority numbers remain
-- supporting metadata only; source-row provenance owns every historical effect.

ALTER TABLE parking_customer_billing_periods
  ADD COLUMN IF NOT EXISTS legacy_source_row integer;

ALTER TABLE parking_customer_billing_periods
  DROP CONSTRAINT IF EXISTS parking_customer_billing_periods_legacy_source_row_check;
ALTER TABLE parking_customer_billing_periods
  ADD CONSTRAINT parking_customer_billing_periods_legacy_source_row_check CHECK (
    (source='LEGACY_EXCEL_IMPORT' AND legacy_source_row IS NOT NULL AND legacy_source_row>0)
    OR (source<>'LEGACY_EXCEL_IMPORT' AND legacy_source_row IS NULL)
  );

DROP INDEX IF EXISTS parking_customer_billing_legacy_period_unique;
CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_billing_nonlegacy_period_unique
  ON parking_customer_billing_periods(customer_id,period_start)
  WHERE booking_id IS NULL AND source<>'LEGACY_EXCEL_IMPORT';
CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_billing_legacy_source_period_unique
  ON parking_customer_billing_periods(legacy_import_batch_id,legacy_source_row,period_start)
  WHERE source='LEGACY_EXCEL_IMPORT';

CREATE TABLE IF NOT EXISTS parking_customer_legacy_parking_records (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^lpr_[A-Za-z0-9_-]{24,80}$'),
  customer_id bigint NOT NULL REFERENCES parking_customers(id) ON DELETE RESTRICT,
  vehicle_id bigint REFERENCES parking_customer_vehicles(id) ON DELETE RESTRICT,
  import_batch_id bigint NOT NULL REFERENCES parking_customer_import_batches(id) ON DELETE RESTRICT,
  source_row integer NOT NULL CHECK (source_row>0),
  source_ref text NOT NULL CHECK (length(trim(source_ref)) BETWEEN 1 AND 260),
  spot_label text,
  start_date date,
  parking_type text CHECK (parking_type IS NULL OR parking_type IN ('DAILY','MONTHLY','IN_PERSON')),
  rate_cents integer CHECK (rate_cents IS NULL OR rate_cents>=0),
  license_plate text,
  unit_number text,
  vehicle_description text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_batch_id,source_row)
);
CREATE INDEX IF NOT EXISTS parking_customer_legacy_parking_customer_idx
  ON parking_customer_legacy_parking_records(customer_id,source_row,id);

CREATE TABLE IF NOT EXISTS parking_customer_legacy_anomalies (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^lan_[A-Za-z0-9_-]{24,80}$'),
  customer_id bigint NOT NULL REFERENCES parking_customers(id) ON DELETE RESTRICT,
  import_batch_id bigint NOT NULL REFERENCES parking_customer_import_batches(id) ON DELETE RESTRICT,
  source_row integer NOT NULL CHECK (source_row>0),
  source_ref text NOT NULL CHECK (length(trim(source_ref)) BETWEEN 1 AND 260),
  period_start date CHECK (period_start IS NULL OR period_start=date_trunc('month',period_start)::date),
  classification text NOT NULL CHECK (classification='NON_FINANCIAL_LEGACY_ANOMALY'),
  anomaly_type text NOT NULL CHECK (anomaly_type IN (
    'LEGACY_NO_RELIABLE_EVIDENCE','LEGACY_UNPARSEABLE','LEGACY_ZERO_WITHOUT_PAYMENT_EVIDENCE'
  )),
  raw_value text NOT NULL,
  financial_effect boolean NOT NULL DEFAULT false CHECK (financial_effect=false),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_batch_id,source_ref)
);
CREATE INDEX IF NOT EXISTS parking_customer_legacy_anomalies_customer_idx
  ON parking_customer_legacy_anomalies(customer_id,period_start,source_row,id);

ALTER TABLE parking_customer_import_rows
  DROP CONSTRAINT IF EXISTS parking_customer_import_rows_classification_check;
ALTER TABLE parking_customer_import_rows
  ADD CONSTRAINT parking_customer_import_rows_classification_check CHECK (classification IN (
    'MATCH_EXISTING','NEW_CUSTOMER','SAME_CUSTOMER_ADDITIONAL_VEHICLE_OR_SPACE',
    'SEPARATE_CUSTOMER_SHARED_CARRIER','BLOCKING_IDENTITY_CONFLICT','INVALID','NON_CUSTOMER'
  ));

DROP TRIGGER IF EXISTS parking_customer_legacy_parking_records_immutable ON parking_customer_legacy_parking_records;
CREATE TRIGGER parking_customer_legacy_parking_records_immutable
  BEFORE UPDATE OR DELETE ON parking_customer_legacy_parking_records
  FOR EACH ROW EXECUTE FUNCTION prevent_customer_financial_audit_mutation();

DROP TRIGGER IF EXISTS parking_customer_legacy_anomalies_immutable ON parking_customer_legacy_anomalies;
CREATE TRIGGER parking_customer_legacy_anomalies_immutable
  BEFORE UPDATE OR DELETE ON parking_customer_legacy_anomalies
  FOR EACH ROW EXECUTE FUNCTION prevent_customer_financial_audit_mutation();
