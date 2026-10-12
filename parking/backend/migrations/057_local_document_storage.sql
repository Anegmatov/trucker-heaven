-- Customer documents can be kept on the server's own disk (DOCUMENT_STORAGE_PROVIDER=LOCAL).
ALTER TABLE parking_customer_documents DROP CONSTRAINT IF EXISTS parking_customer_documents_storage_provider_check;
ALTER TABLE parking_customer_documents ADD CONSTRAINT parking_customer_documents_storage_provider_check
  CHECK (storage_provider IN ('S3','TEST','LOCAL'));
