-- Provenance-backed physical occupancy reconciliation. Spreadsheet formatting
-- is current-state evidence; it never creates financial or Stripe evidence.

CREATE TABLE IF NOT EXISTS parking_occupancy_reconciliation_batches (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^occ_[A-Za-z0-9_-]{24,80}$'),
  source_filename text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_sheet text NOT NULL,
  source_modified_at timestamptz,
  available_colors jsonb NOT NULL,
  internal_colors jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  initiated_by_admin_user_id bigint NOT NULL REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  dry_run_report_sha256 text NOT NULL CHECK (dry_run_report_sha256 ~ '^[a-f0-9]{64}$'),
  rows_considered integer NOT NULL CHECK (rows_considered>=0),
  summary jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(source_sha256,source_sheet)
);

CREATE TABLE IF NOT EXISTS parking_occupancy_reconciliation_rows (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^ocr_[A-Za-z0-9_-]{24,80}$'),
  batch_id bigint NOT NULL REFERENCES parking_occupancy_reconciliation_batches(id) ON DELETE RESTRICT,
  source_row integer NOT NULL CHECK (source_row>0),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  lot_number integer,
  raw_customer text,
  raw_plate text,
  raw_unit text,
  raw_rate_cents integer CHECK (raw_rate_cents IS NULL OR raw_rate_cents>=0),
  raw_date text,
  fill_evidence jsonb NOT NULL,
  classification text NOT NULL CHECK (classification IN (
    'AVAILABLE_YELLOW','AVAILABLE_EMPTY','SHOP_COMPANY_INTERNAL',
    'CUSTOMER_OCCUPIED','INVALID_OR_AMBIGUOUS'
  )),
  resolution text NOT NULL CHECK (resolution IN (
    'PENDING','NO_CHANGE','AVAILABLE','INTERNAL','ASSIGNED','OCCUPANCY_BLOCKED',
    'PROTECTED_NEWER_PARKINGOPS','UNMATCHED_CANONICAL_LOT','CONFLICT_SKIPPED'
  )),
  reason text NOT NULL,
  parking_spot_id bigint REFERENCES parking_spots(id) ON DELETE RESTRICT,
  customer_id bigint REFERENCES parking_customers(id) ON DELETE RESTRICT,
  vehicle_id bigint REFERENCES parking_customer_vehicles(id) ON DELETE RESTRICT,
  previous_state jsonb,
  proposed_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id,source_row)
);
CREATE INDEX IF NOT EXISTS parking_occupancy_reconciliation_lot_idx
  ON parking_occupancy_reconciliation_rows(batch_id,lot_number,classification);

ALTER TABLE parking_customer_vehicles
  ADD COLUMN IF NOT EXISTS occupancy_reconciliation_row_id bigint
    REFERENCES parking_occupancy_reconciliation_rows(id) ON DELETE RESTRICT;
ALTER TABLE parking_customer_vehicles
  DROP CONSTRAINT IF EXISTS parking_customer_vehicles_record_source_check,
  DROP CONSTRAINT IF EXISTS parking_customer_vehicles_source_integrity_check;
ALTER TABLE parking_customer_vehicles
  ADD CONSTRAINT parking_customer_vehicles_record_source_check
    CHECK (record_source IN ('PARKINGOPS','LEGACY_EXCEL_IMPORT','SPREADSHEET_RECONCILIATION')),
  ADD CONSTRAINT parking_customer_vehicles_source_integrity_check CHECK (
    (record_source='PARKINGOPS' AND legacy_import_batch_id IS NULL AND legacy_source_ref IS NULL
      AND occupancy_reconciliation_row_id IS NULL)
    OR (record_source='LEGACY_EXCEL_IMPORT' AND legacy_import_batch_id IS NOT NULL
      AND legacy_source_ref IS NOT NULL AND occupancy_reconciliation_row_id IS NULL)
    OR (record_source='SPREADSHEET_RECONCILIATION' AND legacy_import_batch_id IS NULL
      AND legacy_source_ref IS NULL AND occupancy_reconciliation_row_id IS NOT NULL)
  );
CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_vehicles_occupancy_row_unique
  ON parking_customer_vehicles(occupancy_reconciliation_row_id)
  WHERE occupancy_reconciliation_row_id IS NOT NULL;

ALTER TABLE parking_bookings
  ADD COLUMN IF NOT EXISTS record_source text NOT NULL DEFAULT 'PARKINGOPS',
  ADD COLUMN IF NOT EXISTS occupancy_reconciliation_row_id bigint
    REFERENCES parking_occupancy_reconciliation_rows(id) ON DELETE RESTRICT,
  ALTER COLUMN first_name DROP NOT NULL,
  ALTER COLUMN last_name DROP NOT NULL,
  ALTER COLUMN mobile_phone DROP NOT NULL,
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN tractor_unit_number DROP NOT NULL,
  ALTER COLUMN license_plate DROP NOT NULL,
  ALTER COLUMN license_plate_state DROP NOT NULL,
  ALTER COLUMN terms_accepted_at DROP NOT NULL,
  ALTER COLUMN cancellation_terms_accepted_at DROP NOT NULL;

ALTER TABLE parking_bookings
  DROP CONSTRAINT IF EXISTS parking_bookings_record_source_check,
  DROP CONSTRAINT IF EXISTS parking_bookings_source_identity_check;
ALTER TABLE parking_bookings
  ADD CONSTRAINT parking_bookings_record_source_check
    CHECK (record_source IN ('PARKINGOPS','SPREADSHEET_RECONCILIATION')),
  ADD CONSTRAINT parking_bookings_source_identity_check CHECK (
    (record_source='PARKINGOPS'
      AND occupancy_reconciliation_row_id IS NULL
      AND first_name IS NOT NULL AND last_name IS NOT NULL
      AND mobile_phone IS NOT NULL AND email IS NOT NULL
      AND tractor_unit_number IS NOT NULL AND license_plate IS NOT NULL
      AND license_plate_state IS NOT NULL
      AND terms_accepted_at IS NOT NULL AND cancellation_terms_accepted_at IS NOT NULL)
    OR
    (record_source='SPREADSHEET_RECONCILIATION'
      AND occupancy_reconciliation_row_id IS NOT NULL AND customer_id IS NOT NULL)
  );
CREATE UNIQUE INDEX IF NOT EXISTS parking_bookings_occupancy_row_unique
  ON parking_bookings(occupancy_reconciliation_row_id)
  WHERE occupancy_reconciliation_row_id IS NOT NULL;

ALTER TABLE reservation_spot_assignments
  ADD COLUMN IF NOT EXISTS occupancy_reconciliation_row_id bigint
    REFERENCES parking_occupancy_reconciliation_rows(id) ON DELETE RESTRICT;
ALTER TABLE reservation_spot_assignments
  DROP CONSTRAINT IF EXISTS reservation_spot_assignments_assignment_source_check,
  DROP CONSTRAINT IF EXISTS reservation_spot_assignments_occupancy_source_check;
ALTER TABLE reservation_spot_assignments
  ADD CONSTRAINT reservation_spot_assignments_assignment_source_check
    CHECK (assignment_source IN ('CUSTOMER_AUTO','CUSTOMER_SELECTED','ADMIN_REASSIGN','SYSTEM','SPREADSHEET_RECONCILIATION')),
  ADD CONSTRAINT reservation_spot_assignments_occupancy_source_check CHECK (
    (assignment_source='SPREADSHEET_RECONCILIATION' AND occupancy_reconciliation_row_id IS NOT NULL)
    OR (assignment_source<>'SPREADSHEET_RECONCILIATION' AND occupancy_reconciliation_row_id IS NULL)
  );
CREATE UNIQUE INDEX IF NOT EXISTS reservation_spot_assignments_occupancy_row_unique
  ON reservation_spot_assignments(occupancy_reconciliation_row_id)
  WHERE occupancy_reconciliation_row_id IS NOT NULL;

ALTER TABLE parking_spot_blocks
  ADD COLUMN IF NOT EXISTS occupancy_reconciliation_row_id bigint
    REFERENCES parking_occupancy_reconciliation_rows(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS parking_spot_blocks_occupancy_row_unique
  ON parking_spot_blocks(occupancy_reconciliation_row_id)
  WHERE occupancy_reconciliation_row_id IS NOT NULL;

ALTER TABLE parking_occupancy_reconciliation_rows
  ADD COLUMN IF NOT EXISTS booking_id bigint REFERENCES parking_bookings(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS assignment_id bigint REFERENCES reservation_spot_assignments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS block_id bigint REFERENCES parking_spot_blocks(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS parking_occupancy_rows_booking_unique
  ON parking_occupancy_reconciliation_rows(booking_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS parking_occupancy_rows_assignment_unique
  ON parking_occupancy_reconciliation_rows(assignment_id) WHERE assignment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS parking_occupancy_rows_block_unique
  ON parking_occupancy_reconciliation_rows(block_id) WHERE block_id IS NOT NULL;
