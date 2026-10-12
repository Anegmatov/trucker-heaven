-- Durable integrity metadata for private customer documents. The checksum is
-- populated only after ParkingOps has retrieved and validated the completed
-- object; existing documents remain readable and can be backfilled by a
-- controlled reconciliation process.

ALTER TABLE parking_customer_documents
  ADD COLUMN IF NOT EXISTS sha256_hex text;

ALTER TABLE parking_customer_documents
  DROP CONSTRAINT IF EXISTS parking_customer_documents_sha256_hex_valid;
ALTER TABLE parking_customer_documents
  ADD CONSTRAINT parking_customer_documents_sha256_hex_valid
    CHECK (sha256_hex IS NULL OR sha256_hex ~ '^[a-f0-9]{64}$');

CREATE INDEX IF NOT EXISTS parking_customer_documents_pending_expiry_idx
  ON parking_customer_documents(upload_expires_at,id)
  WHERE upload_status='PENDING_UPLOAD';
