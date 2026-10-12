-- Complete the private customer-document workflow without replacing the
-- storage, booking, customer-account, or audit infrastructure introduced by
-- migrations 031 and 038. Legacy insurance values remain accepted so an
-- older application instance can finish an in-flight request during deploy.

ALTER TABLE parking_customer_documents
  DROP CONSTRAINT IF EXISTS parking_customer_documents_document_type_check;
ALTER TABLE parking_customer_documents
  ADD CONSTRAINT parking_customer_documents_document_type_check
    CHECK (document_type IN ('DRIVER_LICENSE','INSURANCE','VEHICLE_CARRIER_INSURANCE'));

ALTER TABLE parking_customer_documents
  DROP CONSTRAINT IF EXISTS parking_customer_documents_verification_status_check;
ALTER TABLE parking_customer_documents
  ADD CONSTRAINT parking_customer_documents_verification_status_check
    CHECK (verification_status IN ('PENDING_REVIEW','APPROVED','REJECTED','REPLACEMENT_REQUESTED'));

ALTER TABLE parking_customer_documents
  ADD COLUMN IF NOT EXISTS revision integer,
  ADD COLUMN IF NOT EXISTS replaces_document_id bigint REFERENCES parking_customer_documents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

WITH ranked AS (
  SELECT id,row_number() OVER (
    PARTITION BY booking_id,
      CASE WHEN document_type='VEHICLE_CARRIER_INSURANCE' THEN 'INSURANCE' ELSE document_type END
    ORDER BY created_at,id
  ) revision
  FROM parking_customer_documents
)
UPDATE parking_customer_documents document
SET revision=ranked.revision
FROM ranked
WHERE document.id=ranked.id AND document.revision IS NULL;

ALTER TABLE parking_customer_documents
  ALTER COLUMN revision SET DEFAULT 1,
  ALTER COLUMN revision SET NOT NULL;

DROP INDEX IF EXISTS parking_customer_documents_one_current_insurance;
CREATE UNIQUE INDEX IF NOT EXISTS parking_customer_documents_one_current_uploaded
  ON parking_customer_documents(
    booking_id,
    (CASE WHEN document_type='VEHICLE_CARRIER_INSURANCE' THEN 'INSURANCE' ELSE document_type END)
  )
  WHERE upload_status='UPLOADED' AND superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS parking_customer_documents_booking_revision_idx
  ON parking_customer_documents(booking_id,document_type,revision DESC);

ALTER TABLE parking_document_access_audit
  DROP CONSTRAINT IF EXISTS parking_document_access_audit_action_check;
ALTER TABLE parking_document_access_audit
  ADD CONSTRAINT parking_document_access_audit_action_check
    CHECK (action IN (
      'SIGNED_READ_CREATED','VIEWED','DOWNLOADED','APPROVED','REJECTED','REPLACEMENT_REQUESTED'
    ));

CREATE TABLE IF NOT EXISTS parking_document_access_grants (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES parking_customer_documents(id) ON DELETE RESTRICT,
  admin_user_id bigint NOT NULL REFERENCES parking_admin_users(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  disposition text NOT NULL CHECK (disposition IN ('INLINE','ATTACHMENT')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS parking_document_access_grants_expiry_idx
  ON parking_document_access_grants(expires_at) WHERE used_at IS NULL;

ALTER TABLE parking_customer_notification_outbox
  DROP CONSTRAINT IF EXISTS parking_customer_notification_outbox_event_type_check;
ALTER TABLE parking_customer_notification_outbox
  ADD CONSTRAINT parking_customer_notification_outbox_event_type_check
    CHECK (event_type IN (
      'RESERVATION_CONFIRMED','MONTHLY_RENEWED','MONTHLY_PAYMENT_FAILED',
      'CANCELLATION_CONFIRMED','INSURANCE_DOCUMENT_ISSUE','DOCUMENT_REPLACEMENT_REQUESTED'
    ));
