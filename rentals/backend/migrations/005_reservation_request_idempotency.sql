-- Durable public reservation request idempotency and optional customer notes.
ALTER TABLE reservationsmvp
  ADD COLUMN idempotency_key_hash CHAR(64),
  ADD COLUMN idempotency_request_hash CHAR(64),
  ADD COLUMN customernotes VARCHAR(1000);

ALTER TABLE reservationsmvp
  ADD CONSTRAINT reservationsmvp_idempotency_metadata_check
  CHECK (
    (idempotency_key_hash IS NULL AND idempotency_request_hash IS NULL)
    OR
    (idempotency_key_hash IS NOT NULL AND idempotency_request_hash IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_reservationsmvp_idempotency_key_hash
  ON reservationsmvp (idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
