const REQUIRED_MIGRATIONS = [
  "003_admin_auth.sql",
  "004_reservation_availability.sql",
  "005_reservation_request_idempotency.sql",
  "006_rental_operations_lifecycle.sql",
  "007_rental_inspections.sql",
  "008_durable_notifications_admin_controls.sql",
  "010_rental_completion_documents_agreements.sql",
  "011_rental_document_review_history.sql"
];
const REQUIRED_TABLES = [
  "vehicles",
  "vehiclephotos",
  "reservationsmvp",
  "admin_users",
  "admin_sessions",
  "admin_audit_logs",
  "reservation_status_history",
  "rental_inspections",
  "notification_outbox",
  "notification_attempts",
  "rental_documents",
  "rental_document_review_history",
  "rental_agreements",
  "schema_migrations"
];

function constraintDefinitionIsExpected(definition = "") {
  const normalized = String(definition).replace(/\s+/g, " ").toUpperCase();
  return normalized.includes("EXCLUDE USING GIST")
    && normalized.includes("TSTZRANGE(PICKUPAT, RETURNAT, '[)'")
    && normalized.includes("'CONFIRMED'")
    && normalized.includes("'READY_FOR_PICKUP'")
    && normalized.includes("'CHECKED_OUT'")
    && normalized.includes("'RETURNED_PENDING_INSPECTION'");
}

async function checkReadiness(pool) {
  const result = await pool.query(
    `SELECT
      to_regclass('public.vehicles') AS vehicles,
      to_regclass('public.vehiclephotos') AS vehiclephotos,
      to_regclass('public.reservationsmvp') AS reservationsmvp,
      to_regclass('public.admin_users') AS admin_users,
      to_regclass('public.admin_sessions') AS admin_sessions,
      to_regclass('public.admin_audit_logs') AS admin_audit_logs,
      to_regclass('public.reservation_status_history') AS reservation_status_history,
      to_regclass('public.rental_inspections') AS rental_inspections,
      to_regclass('public.notification_outbox') AS notification_outbox,
      to_regclass('public.notification_attempts') AS notification_attempts,
      to_regclass('public.rental_documents') AS rental_documents,
      to_regclass('public.rental_document_review_history') AS rental_document_review_history,
      to_regclass('public.rental_agreements') AS rental_agreements,
      to_regclass('public.schema_migrations') AS schema_migrations,
      EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('public.reservationsmvp')
          AND attname = 'idempotency_key_hash' AND NOT attisdropped
      ) AS idempotency_key_hash_column,
      EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('public.reservationsmvp')
          AND attname = 'idempotency_request_hash' AND NOT attisdropped
      ) AS idempotency_request_hash_column,
      EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('public.reservationsmvp')
          AND attname = 'customernotes' AND NOT attisdropped
      ) AS customer_notes_column,
      EXISTS (
        SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.reservationsmvp')
          AND attname = 'statusversion' AND NOT attisdropped
      ) AS status_version_column,
      EXISTS (
        SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.reservationsmvp')
          AND attname = 'customer_access_token_hash' AND NOT attisdropped
      ) AS customer_access_token_column,
      EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.reservation_status_history')
          AND tgname = 'reservation_status_history_immutable' AND NOT tgisinternal
      ) AS history_immutable,
      (SELECT COUNT(*)::integer FROM pg_constraint WHERE conrelid = to_regclass('public.reservation_status_history')
        AND contype = 'f' AND convalidated) AS history_validated_foreign_keys,
      EXISTS (
        SELECT 1
        FROM pg_index index_record
        JOIN pg_class index_relation ON index_relation.oid = index_record.indexrelid
        WHERE index_record.indrelid = to_regclass('public.reservationsmvp')
          AND index_relation.relname = 'uq_reservationsmvp_idempotency_key_hash'
          AND index_record.indisunique
          AND index_record.indisvalid
      ) AS idempotency_unique_index,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.rental_inspections') AND conname = 'rental_inspections_reservation_type_unique' AND contype = 'u' AND convalidated) AS inspection_unique_constraint,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.rental_inspections') AND conname = 'rental_inspections_inspection_type_check' AND contype = 'c' AND convalidated) AS inspection_type_constraint,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.rental_inspections') AND conname = 'rental_inspections_odometer_check' AND contype = 'c' AND convalidated) AS inspection_odometer_constraint,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.rental_inspections') AND conname = 'rental_inspections_fuel_level_percent_check' AND contype = 'c' AND convalidated) AS inspection_fuel_constraint,
      (SELECT COUNT(*)::integer FROM pg_constraint WHERE conrelid = to_regclass('public.rental_inspections') AND contype = 'f' AND convalidated) AS inspection_foreign_keys,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.rental_inspections') AND tgname = 'rental_inspections_immutable' AND tgenabled = 'O' AND NOT tgisinternal) AS inspection_immutable,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.notification_attempts') AND tgname = 'notification_attempts_immutable' AND tgenabled = 'O' AND NOT tgisinternal) AS notification_attempt_immutable,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.notification_outbox') AND conname = 'notification_outbox_business_event_unique' AND contype = 'u' AND convalidated) AS notification_business_unique,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.notification_attempts') AND conname = 'notification_attempts_notification_attempt_unique' AND contype = 'u' AND convalidated) AS notification_attempt_unique,
      (SELECT COUNT(*)::integer FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'notification_outbox' AND indexname IN ('idx_notification_outbox_eligible', 'idx_notification_outbox_expired_lease', 'idx_notification_outbox_reservation')) AS notification_indexes,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.rental_document_review_history') AND tgname = 'rental_document_review_history_immutable' AND tgenabled = 'O' AND NOT tgisinternal) AS document_review_history_immutable,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.rental_documents') AND tgname = 'rental_document_revision_protected' AND tgenabled = 'O' AND NOT tgisinternal) AS document_revision_protected,
      EXISTS (
        SELECT 1 FROM pg_index index_record
        JOIN pg_class index_relation ON index_relation.oid = index_record.indexrelid
        WHERE index_record.indrelid = to_regclass('public.rental_documents')
          AND index_relation.relname = 'uq_rental_documents_current_type'
          AND index_record.indisunique AND index_record.indisvalid
      ) AS document_current_unique_index,
      EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.admin_users') AND attname = 'account_version' AND NOT attisdropped) AS account_version_column,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.admin_users') AND conname = 'admin_users_account_version_positive' AND contype = 'c' AND convalidated) AS account_version_positive,
      (SELECT COUNT(*)::integer FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'rental_inspections' AND indexname IN ('idx_rental_inspections_reservation', 'idx_rental_inspections_vehicle', 'idx_rental_inspections_completed_at')) AS inspection_indexes,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') AS btree_gist,
      constraint_info.constraint_name,
      constraint_info.constraint_type,
      constraint_info.constraint_validated,
      constraint_info.constraint_definition
     FROM (SELECT 1) AS probe
     LEFT JOIN LATERAL (
       SELECT
         constraint_record.conname AS constraint_name,
         constraint_record.contype AS constraint_type,
         constraint_record.convalidated AS constraint_validated,
         pg_get_constraintdef(constraint_record.oid) AS constraint_definition
       FROM pg_constraint constraint_record
       JOIN pg_class constrained_table ON constrained_table.oid = constraint_record.conrelid
       JOIN pg_namespace constrained_schema ON constrained_schema.oid = constrained_table.relnamespace
       WHERE constrained_schema.nspname = 'public'
         AND constrained_table.relname = 'reservationsmvp'
         AND constraint_record.conname = 'reservationsmvp_blocking_interval_exclusion'
       LIMIT 1
     ) AS constraint_info ON TRUE`
  );
  const schema = result.rows[0] || {};
  const missingTables = REQUIRED_TABLES.filter((table) => !schema[table]);

  if (missingTables.length > 0) {
    return { ready: false, reason: "schema_table_missing" };
  }

  const migrations = await pool.query(
    "SELECT migration FROM public.schema_migrations WHERE migration = ANY($1::text[])",
    [REQUIRED_MIGRATIONS]
  );
  const appliedMigrations = new Set(migrations.rows.map((row) => row.migration));
  if (REQUIRED_MIGRATIONS.some((migration) => !appliedMigrations.has(migration))) {
    return { ready: false, reason: "migration_missing" };
  }

  if (!schema.idempotency_key_hash_column || !schema.idempotency_request_hash_column || !schema.customer_notes_column) {
    return { ready: false, reason: "idempotency_schema_missing" };
  }
  if (!schema.status_version_column) return { ready: false, reason: "schema_column_missing" };
  if (!schema.customer_access_token_column || !schema.document_review_history_immutable || !schema.document_revision_protected || !schema.document_current_unique_index) return { ready: false, reason: "rental_document_schema_invalid" };
  if (!schema.history_immutable || Number(schema.history_validated_foreign_keys) < 2) return { ready: false, reason: "workflow_integrity_missing" };
  if (!schema.idempotency_unique_index) return { ready: false, reason: "idempotency_constraint_missing" };
  if (!schema.inspection_unique_constraint || !schema.inspection_type_constraint || !schema.inspection_odometer_constraint || !schema.inspection_fuel_constraint || Number(schema.inspection_foreign_keys) < 3 || !schema.inspection_immutable || Number(schema.inspection_indexes) < 3) return { ready: false, reason: "inspection_schema_invalid" };
  if (!schema.notification_attempt_immutable || !schema.notification_business_unique || !schema.notification_attempt_unique || Number(schema.notification_indexes) < 3) return { ready: false, reason: "notification_schema_invalid" };
  if (!schema.account_version_column || !schema.account_version_positive) return { ready: false, reason: "admin_account_schema_invalid" };

  if (!schema.btree_gist) return { ready: false, reason: "extension_missing" };
  if (!schema.constraint_name) return { ready: false, reason: "constraint_missing" };
  if (schema.constraint_type !== "x" || !schema.constraint_validated || !constraintDefinitionIsExpected(schema.constraint_definition)) {
    return { ready: false, reason: "constraint_invalid" };
  }

  return { ready: true };
}

module.exports = { REQUIRED_MIGRATIONS, REQUIRED_TABLES, checkReadiness, constraintDefinitionIsExpected };
