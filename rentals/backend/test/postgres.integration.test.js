const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const { Pool } = require("pg");
const { formatReservationRequestNumber } = require("../utils/reservationNumber");

const testDatabaseUrl = process.env.RENTALS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;
let db;
let ensureSchema;
let migrationFiles;
let publicVehiclesRouter;
let adminVehiclesRouter;
let createReservationsRouter;
let createAdminUsersRouter;
let configureAdminMiddleware;
let createRuntimeConfig;
let createSession;
let checkReadiness;
let claimNext;
let finishAttempt;
let processOne;
let mutateAdminUser;

function validateDisposableDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL for an explicitly disposable test database");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(^|[_-])(test|testing|disposable)([_-]|$)/i.test(databaseName)) {
    throw new Error("TEST_DATABASE_URL must name an explicitly disposable test database");
  }
}

if (testDatabaseUrl) {
  validateDisposableDatabaseUrl(testDatabaseUrl);
  if (process.env.RENTALS_DATABASE_URL && process.env.RENTALS_DATABASE_URL === testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL must not reuse RENTALS_DATABASE_URL");
  }
  process.env.RENTALS_DATABASE_URL = testDatabaseUrl;
  process.env.RENTALS_SMS_ENABLED = "false";
  db = require("../db/connection");
  ({ ensureSchema, migrationFiles } = require("../db/initSchema"));
  publicVehiclesRouter = require("../routes/publicVehicles");
  adminVehiclesRouter = require("../routes/adminVehicles");
  ({ createReservationsRouter } = require("../routes/reservations"));
  ({ createAdminUsersRouter } = require("../routes/adminUsers"));
  ({ configureAdminMiddleware } = require("../middleware/requireAdmin"));
  ({ createRuntimeConfig } = require("../config/security"));
  ({ createSession } = require("../services/adminAuthService"));
  ({ checkReadiness } = require("../services/readinessService"));
  ({ claimNext, finishAttempt, processOne } = require("../services/notificationWorker"));
  ({ mutateAdminUser } = require("../services/adminUserService"));
}

function integrationConfig() {
  return createRuntimeConfig({
    NODE_ENV: "test",
    CORS_ALLOWED_ORIGINS: "http://admin.example.test",
    SESSION_TOKEN_PEPPER: "phase-2-test-only-pepper",
    SESSION_TTL_SECONDS: "3600",
    SMS_ENABLED: "false"
  });
}

async function startApi(config) {
  configureAdminMiddleware({ db, config });
  const app = express();
  app.use(express.json());
  app.use("/api/public", publicVehiclesRouter);
  app.use("/api/admin/vehicles", adminVehiclesRouter);
  app.use("/api/admin", createAdminUsersRouter({ database: db }));
  app.use("/api/reservations", createReservationsRouter({ database: db }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function expectExclusionViolation(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, "23P01");
    return true;
  });
}

async function readinessDuring(pool, setupSql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(setupSql);
    return await checkReadiness(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function waitForConcurrentVehicleLockWaiters(pool, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT COUNT(*)::integer AS waiters
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND query LIKE '%FROM vehicles WHERE vehicleid = $1 FOR UPDATE%'`
    );
    if (result.rows[0].waiters >= 2) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("PostgreSQL migrations, readiness, and reservation integrity", async (t) => {
  if (!testDatabaseUrl) {
    return t.skip("TEST_DATABASE_URL is required and must identify an explicitly disposable test database");
  }

  const pool = new Pool({ connectionString: testDatabaseUrl });
  const config = integrationConfig();
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const shortSuffix = suffix.replace(/[^A-Za-z0-9]/g, "").slice(-12);
  const blockingPickup = "2030-01-10T10:00:00Z";
  const blockingReturn = "2030-01-12T10:00:00Z";
  let api;
  let concurrencyBlocker;

  try {
    await t.test("migration runner upgrades released 001-007 data to 008 without rewriting history", async () => {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await ensureSchema(pool, { throughMigration: "007_rental_inspections.sql" });
      const vehicle = await pool.query(
        "INSERT INTO vehicles (make, model, year, category, dailyrate, depositamount) VALUES ('Test', 'Upgrade', 2025, 'Sedan', 1, 1) RETURNING vehicleid"
      );
      const statuses = ["PENDING_REQUEST", "CONFIRMED", "CHECKED_OUT", "COMPLETED", "DECLINED", "CANCELLED", "NO_SHOW"];
      for (const [index, status] of statuses.entries()) {
        await pool.query(
          `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal, idempotency_key_hash, idempotency_request_hash, customernotes)
           VALUES ($1, 'Legacy fixture', $2, $3, $4, $5, 1, $6, $7, $8)`,
          [vehicle.rows[0].vehicleid, `legacy-${index}@example.test`, `2032-01-${String(index + 1).padStart(2, "0")}T10:00:00Z`, `2032-01-${String(index + 2).padStart(2, "0")}T10:00:00Z`, status,
            index === 0 ? "a".repeat(64) : null, index === 0 ? "b".repeat(64) : null, index === 0 ? "preserved note" : null]
        );
      }
      const before = await pool.query("SELECT reservationid, vehicleid, pickupat, returnat, status, idempotency_key_hash, idempotency_request_hash, customernotes FROM reservationsmvp ORDER BY reservationid");
      await ensureSchema(pool);
      await ensureSchema(pool);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM schema_migrations WHERE migration = '006_rental_operations_lifecycle.sql'")).rows[0].count, 1);
      const after = await pool.query("SELECT reservationid, vehicleid, pickupat, returnat, status, idempotency_key_hash, idempotency_request_hash, customernotes, statusversion FROM reservationsmvp ORDER BY reservationid");
      assert.equal(after.rowCount, before.rowCount);
      assert.deepEqual(after.rows.map(({ statusversion, ...row }) => row), before.rows);
      assert.ok(after.rows.every((row) => row.statusversion === 1));
      assert.equal(formatReservationRequestNumber(after.rows[0].reservationid), formatReservationRequestNumber(before.rows[0].reservationid));
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM reservation_status_history")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM rental_inspections")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM schema_migrations WHERE migration = '007_rental_inspections.sql'")).rows[0].count, 1);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM schema_migrations WHERE migration = '008_durable_notifications_admin_controls.sql'")).rows[0].count, 1);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM notification_attempts")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM admin_users WHERE NOT is_active OR account_version <> 1")).rows[0].count, 0);
      assert.deepEqual(await checkReadiness(pool), { ready: true });
      const constraint = await pool.query("SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'reservationsmvp_blocking_interval_exclusion'");
      assert.equal(constraint.rows[0].convalidated, true);
      assert.match(constraint.rows[0].definition, /READY_FOR_PICKUP/);
      const confirmed = after.rows.find((row) => row.status === "CONFIRMED");
      await expectExclusionViolation(pool.query(
        `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
         VALUES ($1, 'New status conflict', 'new-status-conflict@example.test', $2, $3, 'READY_FOR_PICKUP', 1)`,
        [confirmed.vehicleid, confirmed.pickupat, confirmed.returnat]
      ));
    });

    await t.test("migration 006 rejects a controlled pre-constraint blocking conflict atomically", async () => {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await ensureSchema(pool, { throughMigration: "005_reservation_request_idempotency.sql" });
      await pool.query("ALTER TABLE reservationsmvp DROP CONSTRAINT reservationsmvp_blocking_interval_exclusion");
      await pool.query("ALTER TABLE reservationsmvp DROP CONSTRAINT reservationsmvp_status_transition_values_check");
      await pool.query("ALTER TABLE reservationsmvp ADD CONSTRAINT reservationsmvp_status_transition_values_check CHECK (UPPER(status) IN ('PENDING_REQUEST','CONFIRMED','READY_FOR_PICKUP','CHECKED_OUT','COMPLETED','DECLINED','CANCELLED','NO_SHOW'))");
      const vehicle = await pool.query("INSERT INTO vehicles (make, model, year, category, dailyrate, depositamount) VALUES ('Test', 'Unsafe migration', 2025, 'Sedan', 1, 1) RETURNING vehicleid");
      await pool.query(
        `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
         VALUES ($1, 'Fixture A', 'fixture-a@example.test', '2033-01-10T10:00:00Z', '2033-01-12T10:00:00Z', 'CONFIRMED', 1),
                ($1, 'Fixture B', 'fixture-b@example.test', '2033-01-10T10:00:00Z', '2033-01-12T10:00:00Z', 'READY_FOR_PICKUP', 1)`,
        [vehicle.rows[0].vehicleid]
      );
      await assert.rejects(() => ensureSchema(pool), /Cannot add Phase 7A overlap protection/);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM schema_migrations WHERE migration = '006_rental_operations_lifecycle.sql'")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT to_regclass('public.reservation_status_history') AS history")).rows[0].history, null);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM pg_attribute WHERE attrelid = 'reservationsmvp'::regclass AND attname = 'statusversion'")).rows[0].count, 0);
      const preserved = await pool.query("SELECT status FROM reservationsmvp ORDER BY reservationid");
      assert.deepEqual(preserved.rows.map((row) => row.status), ["CONFIRMED", "READY_FOR_PICKUP"]);
    });

    await t.test("migration 008 controlled failure rolls back without partial notification or account schema", async () => {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await ensureSchema(pool, { throughMigration: "007_rental_inspections.sql" });
      const vehicle = await pool.query("INSERT INTO vehicles (make, model, year, category, dailyrate, depositamount) VALUES ('Test', 'Migration rollback', 2025, 'Sedan', 1, 1) RETURNING vehicleid");
      const reservation = await pool.query("INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal) VALUES ($1, 'Fixture', 'fixture@example.test', '2034-01-01T10:00:00Z', '2034-01-02T10:00:00Z', 'PENDING_REQUEST', 1) RETURNING reservationid", [vehicle.rows[0].vehicleid]);
      const user = await pool.query("INSERT INTO admin_users (email, password_hash, role) VALUES ('rollback-owner@example.test', 'fixture-hash', 'OWNER') RETURNING id");
      await pool.query("INSERT INTO admin_sessions (token_hash, csrf_token_hash, admin_user_id, expires_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '1 hour')", ["a".repeat(64), "b".repeat(64), user.rows[0].id]);
      await pool.query("CREATE VIEW notification_outbox AS SELECT 1::bigint AS id");
      await assert.rejects(() => ensureSchema(pool), /notification_outbox/);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM schema_migrations WHERE migration = '008_durable_notifications_admin_controls.sql'")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT to_regclass('public.notification_attempts') AS relation")).rows[0].relation, null);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM pg_attribute WHERE attrelid = 'admin_users'::regclass AND attname = 'account_version'")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM reservationsmvp WHERE reservationid = $1", [reservation.rows[0].reservationid])).rows[0].count, 1);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM admin_sessions WHERE admin_user_id = $1", [user.rows[0].id])).rows[0].count, 1);
    });

    // This test is intentionally destructive only to the explicitly named TEST database.
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    const emptySchema = await pool.query("SELECT to_regclass('public.schema_migrations') AS schema_migrations");
    assert.equal(emptySchema.rows[0].schema_migrations, null);

    assert.deepEqual(await migrationFiles(), [
      "001_driveops_mvp.sql",
      "002_legacy_compatibility.sql",
      "003_admin_auth.sql",
      "004_reservation_availability.sql",
      "005_reservation_request_idempotency.sql",
      "006_rental_operations_lifecycle.sql",
      "007_rental_inspections.sql",
      "008_durable_notifications_admin_controls.sql",
      "009_food_owner_staff.sql",
      "010_rental_completion_documents_agreements.sql",
      "011_rental_document_review_history.sql",
      "012_counter_checkout_and_payments.sql",
      "013_drop_food_and_legacy.sql"
    ]);
    await ensureSchema(pool);

    const version = await pool.query("SHOW server_version_num");
    assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000);

    await t.test("two PostgreSQL workers claim once, recover leases, reject stale finalization, and dead-letter ambiguous delivery", async () => {
      const vehicle = await pool.query("INSERT INTO vehicles (make, model, year, category, dailyrate, depositamount) VALUES ('Test', 'Worker', 2025, 'Sedan', 1, 1) RETURNING vehicleid");
      const reservation = await pool.query("INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal) VALUES ($1, 'Worker fixture', 'worker@example.test', '2035-01-01T10:00:00Z', '2035-01-02T10:00:00Z', 'PENDING_REQUEST', 1) RETURNING reservationid", [vehicle.rows[0].vehicleid]);
      const insertOutbox = async (key) => (await pool.query(
        `INSERT INTO notification_outbox (reservation_id, channel, event_type, business_event_key, template_key, content_hash)
         VALUES ($1, 'SMS', 'RESERVATION_CREATED_OFFICE', $2, 'OFFICE_RESERVATION_CREATED', $3) RETURNING id`,
        [reservation.rows[0].reservationid, key, "c".repeat(64)]
      )).rows[0].id;
      const config = { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, leaseMs: 1000 };
      const firstId = await insertOutbox("worker-once");
      let providerCalls = 0;
      const results = await Promise.all([
        processOne({ database: db, config, smsService: { sendSms: async () => { providerCalls += 1; return { status: "sent", providerMessageId: "accepted-test" }; } } }),
        processOne({ database: db, config, smsService: { sendSms: async () => { providerCalls += 1; return { status: "sent", providerMessageId: "accepted-test" }; } } })
      ]);
      assert.equal(results.filter((result) => result.processed).length, 1);
      assert.equal(providerCalls, 1);
      assert.deepEqual((await pool.query("SELECT status, attempt_count FROM notification_outbox WHERE id = $1", [firstId])).rows[0], { status: "SENT", attempt_count: 1 });
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM notification_attempts WHERE notification_id = $1", [firstId])).rows[0].count, 1);

      const leaseId = await insertOutbox("worker-expired-lease");
      await pool.query("UPDATE notification_outbox SET status = 'PROCESSING', lease_token = $1, lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $2", ["00000000-0000-4000-8000-000000000001", leaseId]);
      const recovered = await claimNext(db, config);
      assert.equal(Number(recovered.notification.id), Number(leaseId));
      assert.equal(await finishAttempt(db, { notification: recovered.notification, token: "00000000-0000-4000-8000-000000000001" }, { status: "sent" }, 1, config), false);
      assert.equal(await finishAttempt(db, recovered, { status: "skipped", code: "PROVIDER_NOT_CONFIGURED" }, 1, config), true);
      assert.deepEqual((await pool.query("SELECT status, attempt_count FROM notification_outbox WHERE id = $1", [leaseId])).rows[0], { status: "SKIPPED", attempt_count: 1 });

      const crashWindowId = await insertOutbox("worker-crash-after-acceptance");
      const acceptedThenCrashed = await claimNext(db, config);
      assert.equal(Number(acceptedThenCrashed.notification.id), Number(crashWindowId));
      let crashWindowCalls = 1; // Simulated provider acceptance before the worker exits without finalizing.
      await pool.query("UPDATE notification_outbox SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [crashWindowId]);
      await processOne({ database: db, config, smsService: { sendSms: async () => { crashWindowCalls += 1; return { status: "sent", providerMessageId: "accepted-after-recovery" }; } } });
      assert.equal(crashWindowCalls, 2, "without provider idempotency, crash recovery is explicitly at-least-once");
      assert.deepEqual((await pool.query("SELECT status, attempt_count FROM notification_outbox WHERE id = $1", [crashWindowId])).rows[0], { status: "SENT", attempt_count: 1 });

      const ambiguousId = await insertOutbox("worker-ambiguous");
      await processOne({ database: db, config, smsService: { sendSms: async () => ({ status: "failed", ambiguous: true }) } });
      assert.deepEqual((await pool.query("SELECT status, attempt_count, last_error_code FROM notification_outbox WHERE id = $1", [ambiguousId])).rows[0], { status: "DEAD_LETTER", attempt_count: 1, last_error_code: "DELIVERY_OUTCOME_UNKNOWN" });
    });

    const migrations = await pool.query("SELECT migration FROM schema_migrations ORDER BY migration");
    assert.deepEqual(migrations.rows.map((row) => row.migration), [
      "001_driveops_mvp.sql",
      "002_legacy_compatibility.sql",
      "003_admin_auth.sql",
      "004_reservation_availability.sql",
      "005_reservation_request_idempotency.sql",
      "006_rental_operations_lifecycle.sql",
      "007_rental_inspections.sql",
      "008_durable_notifications_admin_controls.sql",
      "009_food_owner_staff.sql",
      "010_rental_completion_documents_agreements.sql",
      "011_rental_document_review_history.sql",
      "012_counter_checkout_and_payments.sql",
      "013_drop_food_and_legacy.sql"
    ]);

    const tables = await pool.query(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename = ANY($1::text[])
       ORDER BY tablename`,
      [["admin_users", "admin_sessions", "admin_audit_logs", "rental_inspections", "notification_outbox", "notification_attempts", "reservation_status_history", "vehicles", "vehiclephotos", "reservationsmvp", "schema_migrations"]]
    );
    assert.deepEqual(tables.rows.map((row) => row.tablename), [
      "admin_audit_logs",
      "admin_sessions",
      "admin_users",
      "notification_attempts",
      "notification_outbox",
      "rental_inspections",
      "reservation_status_history",
      "reservationsmvp",
      "schema_migrations",
      "vehiclephotos",
      "vehicles"
    ]);

    const extension = await pool.query("SELECT extname FROM pg_extension WHERE extname = 'btree_gist'");
    assert.equal(extension.rowCount, 1);
    const indexes = await pool.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [["idx_admin_sessions_active", "idx_rental_inspections_completed_at", "idx_rental_inspections_reservation", "idx_rental_inspections_vehicle", "idx_reservation_status_history_reservation_created", "idx_reservationsmvp_blocking_interval", "uq_reservation_status_history_reservation_version", "uq_reservationsmvp_idempotency_key_hash", "uq_vehiclephotos_primary_per_vehicle"]]
    );
    assert.deepEqual(indexes.rows.map((row) => row.indexname), [
      "idx_admin_sessions_active",
      "idx_rental_inspections_completed_at",
      "idx_rental_inspections_reservation",
      "idx_rental_inspections_vehicle",
      "idx_reservation_status_history_reservation_created",
      "idx_reservationsmvp_blocking_interval",
      "uq_reservation_status_history_reservation_version",
      "uq_reservationsmvp_idempotency_key_hash",
      "uq_vehiclephotos_primary_per_vehicle"
    ]);

    const idempotencyColumns = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'reservationsmvp'
         AND column_name = ANY($1::text[])
       ORDER BY column_name`,
      [["customernotes", "idempotency_key_hash", "idempotency_request_hash", "statusversion"]]
    );
    assert.deepEqual(idempotencyColumns.rows.map((row) => row.column_name), [
      "customernotes",
      "idempotency_key_hash",
      "idempotency_request_hash",
      "statusversion"
    ]);

    const constraint = await pool.query(
      `SELECT constrained_table.relname AS table_name,
              constraint_record.contype AS constraint_type,
              constraint_record.convalidated,
              pg_get_constraintdef(constraint_record.oid) AS definition
       FROM pg_constraint constraint_record
       JOIN pg_class constrained_table ON constrained_table.oid = constraint_record.conrelid
       JOIN pg_namespace constrained_schema ON constrained_schema.oid = constrained_table.relnamespace
       WHERE constrained_schema.nspname = 'public'
         AND constraint_record.conname = 'reservationsmvp_blocking_interval_exclusion'`
    );
    assert.equal(constraint.rowCount, 1);
    assert.equal(constraint.rows[0].table_name, "reservationsmvp");
    assert.equal(constraint.rows[0].constraint_type, "x");
    assert.equal(constraint.rows[0].convalidated, true);
    assert.match(constraint.rows[0].definition, /tstzrange\(pickupat, returnat, '\[\)'/i);
    assert.match(constraint.rows[0].definition, /CONFIRMED/);
    assert.match(constraint.rows[0].definition, /READY_FOR_PICKUP/);
    assert.match(constraint.rows[0].definition, /CHECKED_OUT/);
    assert.match(constraint.rows[0].definition, /RETURNED_PENDING_INSPECTION/);

    assert.deepEqual(await checkReadiness(pool), { ready: true });
    assert.deepEqual(
      await readinessDuring(pool, "DROP TABLE public.vehiclephotos"),
      { ready: false, reason: "schema_table_missing" }
    );
    assert.deepEqual(
      await readinessDuring(pool, "DROP TABLE public.admin_sessions"),
      { ready: false, reason: "schema_table_missing" }
    );
    assert.deepEqual(
      await readinessDuring(pool, "DELETE FROM public.schema_migrations WHERE migration = '003_admin_auth.sql'"),
      { ready: false, reason: "migration_missing" }
    );
    assert.deepEqual(
      await readinessDuring(pool, "DELETE FROM public.schema_migrations WHERE migration = '004_reservation_availability.sql'"),
      { ready: false, reason: "migration_missing" }
    );
    assert.deepEqual(
      await readinessDuring(pool, "DELETE FROM public.schema_migrations WHERE migration = '005_reservation_request_idempotency.sql'"),
      { ready: false, reason: "migration_missing" }
    );
    assert.deepEqual(
      await readinessDuring(pool, "DELETE FROM public.schema_migrations WHERE migration = '006_rental_operations_lifecycle.sql'"),
      { ready: false, reason: "migration_missing" }
    );
    assert.deepEqual(
      await readinessDuring(pool, "ALTER TABLE public.reservationsmvp DROP COLUMN idempotency_request_hash"),
      { ready: false, reason: "idempotency_schema_missing" }
    );
    assert.deepEqual(
      await readinessDuring(pool, "DROP INDEX public.uq_reservationsmvp_idempotency_key_hash"),
      { ready: false, reason: "idempotency_constraint_missing" }
    );
    assert.deepEqual(
      await readinessDuring(pool, "DROP EXTENSION btree_gist CASCADE"),
      { ready: false, reason: "extension_missing" }
    );
    assert.deepEqual(
      await readinessDuring(pool, "ALTER TABLE public.reservationsmvp DROP CONSTRAINT reservationsmvp_blocking_interval_exclusion"),
      { ready: false, reason: "constraint_missing" }
    );
    assert.deepEqual(await checkReadiness(pool), { ready: true });

    const apiUser = await pool.query(
      `INSERT INTO admin_users (email, password_hash, role)
       VALUES ($1, 'integration-test-not-a-login-hash', 'OWNER')
       RETURNING id, email, role`,
      [`phase2-admin-${suffix}@example.test`]
    );
    const session = await createSession(db, apiUser.rows[0], config, "phase-2-integration-test");
    const authHeaders = {
      Cookie: `${config.session.cookieName}=${session.token}`,
      [config.session.csrfHeaderName]: session.csrfToken
    };
    api = await startApi(config);
    const idempotencyHeaders = (label) => ({ "Idempotency-Key": `${label}-${shortSuffix}-1234567890abcdef` });

    const vehicles = await pool.query(
      `INSERT INTO vehicles (vin, make, model, year, category, dailyrate, depositamount)
       VALUES
         ($1, 'Test', 'Blocking', 2025, 'Sedan', 75, 100),
         ($2, 'Test', 'Checkout', 2025, 'SUV', 80, 100),
         ($3, 'Test', 'Pending', 2025, 'Van', 85, 100)
       RETURNING vehicleid, vin`,
      [`P2BLOCK${shortSuffix}`, `P2CHECK${shortSuffix}`, `P2PEND${shortSuffix}`]
    );
    const blockingVehicleId = vehicles.rows.find((row) => row.vin.startsWith("P2BLOCK")).vehicleid;
    const checkoutVehicleId = vehicles.rows.find((row) => row.vin.startsWith("P2CHECK")).vehicleid;
    const pendingVehicleId = vehicles.rows.find((row) => row.vin.startsWith("P2PEND")).vehicleid;

    await pool.query(
      `INSERT INTO reservationsmvp
        (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES
         ($1, 'Blocking customer', $2, $3, $4, 'CONFIRMED', 75),
         ($5, 'Checkout customer', $6, $3, $4, 'CHECKED_OUT', 80),
         ($7, 'Pending customer', $8, $3, $4, 'PENDING_REQUEST', 85)`,
      [
        blockingVehicleId,
        `blocking-${suffix}@example.test`,
        blockingPickup,
        blockingReturn,
        checkoutVehicleId,
        `checkout-${suffix}@example.test`,
        pendingVehicleId,
        `pending-${suffix}@example.test`
      ]
    );

    const noDates = await requestJson(api.baseUrl, "/api/public/vehicles");
    assert.equal(noDates.status, 200);
    assert.deepEqual(Object.keys(noDates.body), ["vehicles"]);
    assert.ok(noDates.body.vehicles.some((vehicle) => vehicle.id === blockingVehicleId));
    assert.ok(noDates.body.vehicles.some((vehicle) => vehicle.id === checkoutVehicleId));
    assert.ok(noDates.body.vehicles.some((vehicle) => vehicle.id === pendingVehicleId));

    const interval = new URLSearchParams({ pickupAt: blockingPickup, returnAt: blockingReturn });
    const overlapping = await requestJson(api.baseUrl, `/api/public/vehicles?${interval}`);
    assert.equal(overlapping.status, 200);
    assert.deepEqual(Object.keys(overlapping.body), ["vehicles"]);
    assert.ok(!overlapping.body.vehicles.some((vehicle) => vehicle.id === blockingVehicleId));
    assert.ok(!overlapping.body.vehicles.some((vehicle) => vehicle.id === checkoutVehicleId));
    assert.ok(overlapping.body.vehicles.some((vehicle) => vehicle.id === pendingVehicleId));

    const detailWithoutDates = await requestJson(api.baseUrl, `/api/public/vehicles/${blockingVehicleId}`);
    assert.equal(detailWithoutDates.status, 200);
    const detailWithOverlappingDates = await requestJson(api.baseUrl, `/api/public/vehicles/${blockingVehicleId}?${interval}`);
    assert.equal(detailWithOverlappingDates.status, 404);

    const backToBack = await requestJson(
      api.baseUrl,
      `/api/public/vehicles?${new URLSearchParams({ pickupAt: blockingReturn, returnAt: "2030-01-13T10:00:00Z" })}`
    );
    assert.equal(backToBack.status, 200);
    assert.ok(backToBack.body.vehicles.some((vehicle) => vehicle.id === blockingVehicleId));
    assert.ok(backToBack.body.vehicles.some((vehicle) => vehicle.id === checkoutVehicleId));

    const incomplete = await requestJson(api.baseUrl, `/api/public/vehicles?pickupAt=${encodeURIComponent(blockingPickup)}`);
    assert.equal(incomplete.status, 400);
    assert.equal(typeof incomplete.body.error, "string");
    const malformed = await requestJson(
      api.baseUrl,
      "/api/public/vehicles?pickupAt=not-a-timestamp&returnAt=2030-01-13T10%3A00%3A00Z"
    );
    assert.equal(malformed.status, 400);
    const equalDates = await requestJson(
      api.baseUrl,
      `/api/public/vehicles?${new URLSearchParams({ pickupAt: blockingPickup, returnAt: blockingPickup })}`
    );
    assert.equal(equalDates.status, 400);
    const returnBeforePickup = await requestJson(
      api.baseUrl,
      `/api/public/vehicles?${new URLSearchParams({ pickupAt: blockingReturn, returnAt: blockingPickup })}`
    );
    assert.equal(returnBeforePickup.status, 400);

    const conflictingRequest = await requestJson(api.baseUrl, "/api/reservations", {
      method: "POST",
      headers: idempotencyHeaders("conflicting-request"),
      body: JSON.stringify({
        vehicleId: blockingVehicleId,
        customerName: "Request conflict",
        customerEmail: `request-conflict-${suffix}@example.test`,
        customerPhone: "5550000000",
        pickupAt: blockingPickup,
        returnAt: blockingReturn
      })
    });
    assert.equal(conflictingRequest.status, 409);
    assert.equal(conflictingRequest.body.error, "Vehicle is not available for the requested dates");

    const adjacentRequest = await requestJson(api.baseUrl, "/api/reservations", {
      method: "POST",
      headers: idempotencyHeaders("adjacent-request"),
      body: JSON.stringify({
        vehicleId: blockingVehicleId,
        customerName: "Request boundary",
        customerEmail: `request-boundary-${suffix}@example.test`,
        customerPhone: "5550000000",
        pickupAt: blockingReturn,
        returnAt: "2030-01-13T10:00:00Z"
      })
    });
    assert.equal(adjacentRequest.status, 201);
    assert.deepEqual(Object.keys(adjacentRequest.body).sort(), ["message", "reservation"]);
    assert.deepEqual(
      Object.keys(adjacentRequest.body.reservation).sort(),
      ["DepositAmount", "EstimatedTotal", "NotificationStatus", "ReservationID", "Status", "VehicleID", "payment", "requestNumber"]
    );
    assert.equal(adjacentRequest.body.reservation.VehicleID, blockingVehicleId);
    assert.equal(adjacentRequest.body.reservation.payment.method, "PAY_AT_PICKUP");

    await pool.query("UPDATE vehicles SET status = 'MAINTENANCE' WHERE vehicleid = $1", [pendingVehicleId]);
    const operationallyUnavailable = await requestJson(api.baseUrl, "/api/public/vehicles");
    assert.equal(operationallyUnavailable.status, 200);
    assert.ok(!operationallyUnavailable.body.vehicles.some((vehicle) => vehicle.id === pendingVehicleId));

    const legacyRows = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM reservationsmvp WHERE idempotency_key_hash IS NULL AND idempotency_request_hash IS NULL"
    );
    assert.ok(legacyRows.rows[0].count >= 3, "migration 005 must keep rows without idempotency metadata valid");

    const idempotencyVehicle = await pool.query(
      `INSERT INTO vehicles (vin, make, model, year, category, dailyrate, depositamount)
       VALUES ($1, 'Test', 'Idempotency', 2025, 'Sedan', 95, 125)
       RETURNING vehicleid`,
      [`P3IDEM${shortSuffix}`]
    );
    const idempotencyVehicleId = idempotencyVehicle.rows[0].vehicleid;
    const idempotentPayload = {
      vehicleId: idempotencyVehicleId,
      customerName: "Idempotent Customer",
      customerEmail: `idempotent-${suffix}@example.test`,
      customerPhone: "+1 (615) 555-0101",
      pickupAt: "2030-02-01T10:00:00Z",
      returnAt: "2030-02-03T10:00:00Z",
      notes: "Handle with care."
    };

    const missingKey = await requestJson(api.baseUrl, "/api/reservations", {
      method: "POST",
      body: JSON.stringify(idempotentPayload)
    });
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.code, "INVALID_IDEMPOTENCY_KEY");
    const malformedKey = await requestJson(api.baseUrl, "/api/reservations", {
      method: "POST",
      headers: { "Idempotency-Key": "bad key" },
      body: JSON.stringify(idempotentPayload)
    });
    assert.equal(malformedKey.status, 400);
    assert.equal(malformedKey.body.code, "INVALID_IDEMPOTENCY_KEY");

    const idempotencyKeyHeaders = idempotencyHeaders("same-request");
    const firstRequest = await requestJson(api.baseUrl, "/api/reservations", {
      method: "POST",
      headers: idempotencyKeyHeaders,
      body: JSON.stringify(idempotentPayload)
    });
    assert.equal(firstRequest.status, 201);
    assert.match(firstRequest.body.reservation.requestNumber, /^R-\d{4,}$/);
    assert.equal(firstRequest.body.reservation.NotificationStatus, "queued");
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM notification_outbox WHERE reservation_id = $1", [firstRequest.body.reservation.ReservationID])).rows[0].count, 2);
    const replay = await requestJson(api.baseUrl, "/api/reservations", {
      method: "POST",
      headers: idempotencyKeyHeaders,
      body: JSON.stringify({
        ...idempotentPayload,
        customerName: "  Idempotent   Customer  ",
        customerEmail: idempotentPayload.customerEmail.toUpperCase(),
        customerPhone: "+16155550101"
      })
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotent-replay"), "true");
    assert.deepEqual(replay.body, firstRequest.body);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM notification_outbox WHERE reservation_id = $1", [firstRequest.body.reservation.ReservationID])).rows[0].count, 2, "an idempotent replay must not enqueue another event");
    const adminReservationList = await requestJson(api.baseUrl, "/api/reservations", { headers: authHeaders });
    const listedIdempotentReservation = adminReservationList.body.reservations.find(
      (reservation) => reservation.ReservationID === firstRequest.body.reservation.ReservationID
    );
    assert.equal(listedIdempotentReservation.RequestNumber, firstRequest.body.reservation.requestNumber);

    const changedReplay = await requestJson(api.baseUrl, "/api/reservations", {
      method: "POST",
      headers: idempotencyKeyHeaders,
      body: JSON.stringify({ ...idempotentPayload, customerName: "Different Customer" })
    });
    assert.equal(changedReplay.status, 409);
    assert.equal(changedReplay.body.code, "IDEMPOTENCY_CONFLICT");

    const identicalConcurrentPayload = {
      ...idempotentPayload,
      customerEmail: `concurrent-identical-${suffix}@example.test`,
      pickupAt: "2030-02-05T10:00:00Z",
      returnAt: "2030-02-06T10:00:00Z",
      notes: "Concurrent identical request"
    };
    const identicalHeaders = idempotencyHeaders("concurrent-identical");
    const identicalResults = await Promise.all([
      requestJson(api.baseUrl, "/api/reservations", { method: "POST", headers: identicalHeaders, body: JSON.stringify(identicalConcurrentPayload) }),
      requestJson(api.baseUrl, "/api/reservations", { method: "POST", headers: identicalHeaders, body: JSON.stringify(identicalConcurrentPayload) })
    ]);
    assert.deepEqual(identicalResults.map((result) => result.status), [201, 201]);
    assert.equal(new Set(identicalResults.map((result) => result.body.reservation.ReservationID)).size, 1);
    const identicalRows = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM reservationsmvp WHERE vehicleid = $1 AND customeremail = $2",
      [idempotencyVehicleId, identicalConcurrentPayload.customerEmail]
    );
    assert.equal(identicalRows.rows[0].count, 1);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM notification_outbox WHERE reservation_id = $1", [identicalResults[0].body.reservation.ReservationID])).rows[0].count, 2);

    const differentHeaders = idempotencyHeaders("concurrent-different");
    const differentBase = {
      ...idempotentPayload,
      customerEmail: `concurrent-different-${suffix}@example.test`,
      pickupAt: "2030-02-08T10:00:00Z",
      returnAt: "2030-02-09T10:00:00Z"
    };
    const differentResults = await Promise.all([
      requestJson(api.baseUrl, "/api/reservations", { method: "POST", headers: differentHeaders, body: JSON.stringify({ ...differentBase, notes: "Payload one" }) }),
      requestJson(api.baseUrl, "/api/reservations", { method: "POST", headers: differentHeaders, body: JSON.stringify({ ...differentBase, notes: "Payload two" }) })
    ]);
    assert.deepEqual(differentResults.map((result) => result.status).sort(), [201, 409]);
    assert.equal(differentResults.find((result) => result.status === 409).body.code, "IDEMPOTENCY_CONFLICT");
    const differentRows = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM reservationsmvp WHERE vehicleid = $1 AND customeremail = $2",
      [idempotencyVehicleId, differentBase.customerEmail]
    );
    assert.equal(differentRows.rows[0].count, 1);

    const missingVehicle = await requestJson(api.baseUrl, "/api/reservations", {
      method: "POST",
      headers: idempotencyHeaders("missing-vehicle"),
      body: JSON.stringify({ ...idempotentPayload, vehicleId: 2147483647 })
    });
    assert.equal(missingVehicle.status, 404);

    const providerFailure = await requestJson(api.baseUrl, "/api/reservations", {
      method: "POST",
      headers: idempotencyHeaders("provider-failure"),
      body: JSON.stringify({
        ...idempotentPayload,
        customerEmail: `provider-failure-${suffix}@example.test`,
        pickupAt: "2030-02-11T10:00:00Z",
        returnAt: "2030-02-12T10:00:00Z"
      })
    });
    assert.equal(providerFailure.status, 201);
    assert.equal(providerFailure.body.reservation.NotificationStatus, "queued");
    const committedAfterSmsFailure = await pool.query(
      "SELECT status FROM reservationsmvp WHERE reservationid = $1",
      [providerFailure.body.reservation.ReservationID]
    );
    assert.equal(committedAfterSmsFailure.rows[0].status, "PENDING_REQUEST");

    const noShowVehicle = await pool.query(
      `INSERT INTO vehicles (vin, make, model, year, category, dailyrate, depositamount)
       VALUES ($1, 'Test', 'No show workflow', 2025, 'Sedan', 90, 100)
       RETURNING vehicleid`,
      [`P4NOSHOW${shortSuffix}`]
    );
    const noShowVehicleId = noShowVehicle.rows[0].vehicleid;
    const noShowRows = await pool.query(
      `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES ($1, 'No show confirmed', $2, '2030-04-10T10:00:00Z', '2030-04-12T10:00:00Z', 'CONFIRMED', 180),
              ($1, 'No show invalid source', $3, '2030-05-10T10:00:00Z', '2030-05-12T10:00:00Z', 'PENDING_REQUEST', 180)
       RETURNING reservationid, status`,
      [noShowVehicleId, `no-show-${suffix}@example.test`, `no-show-pending-${suffix}@example.test`]
    );
    const confirmedNoShowId = noShowRows.rows.find((row) => row.status === "CONFIRMED").reservationid;
    const pendingNoShowId = noShowRows.rows.find((row) => row.status === "PENDING_REQUEST").reservationid;
    const blockedBeforeNoShow = await requestJson(
      api.baseUrl,
      "/api/public/vehicles?pickupAt=2030-04-11T10%3A00%3A00Z&returnAt=2030-04-11T12%3A00%3A00Z"
    );
    assert.ok(!blockedBeforeNoShow.body.vehicles.some((vehicle) => vehicle.id === noShowVehicleId));

    const staffUser = await pool.query(
      `INSERT INTO admin_users (email, password_hash, role)
       VALUES ($1, 'integration-test-not-a-login-hash', 'STAFF')
       RETURNING id, email, role`,
      [`phase4-staff-${suffix}@example.test`]
    );
    const staffSession = await createSession(db, staffUser.rows[0], config, "phase-4-staff-test");
    const staffHeaders = {
      Cookie: `${config.session.cookieName}=${staffSession.token}`,
      [config.session.csrfHeaderName]: staffSession.csrfToken
    };
    const staffNoShow = await requestJson(api.baseUrl, `/api/reservations/${pendingNoShowId}/operations/no_show`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({ expectedStatusVersion: 1 })
    });
    assert.equal(staffNoShow.status, 409);
    assert.equal((await requestJson(api.baseUrl, `/api/admin/vehicles/${noShowVehicleId}/status`, {
      method: "PATCH", headers: staffHeaders, body: JSON.stringify({ status: "MAINTENANCE" })
    })).status, 403);
    assert.equal((await requestJson(api.baseUrl, "/api/admin/users")).status, 401);
    assert.equal((await requestJson(api.baseUrl, `/api/admin/users/${staffUser.rows[0].id}/operations/change-role`, {
      method: "POST", headers: { Cookie: authHeaders.Cookie }, body: JSON.stringify({ expectedAccountVersion: 1, role: "OWNER" })
    })).status, 403);
    assert.equal((await requestJson(api.baseUrl, `/api/admin/users/${staffUser.rows[0].id}/operations/disable`, {
      method: "POST", headers: staffHeaders, body: JSON.stringify({ expectedAccountVersion: 1 })
    })).status, 403);
    const employeeList = await requestJson(api.baseUrl, "/api/admin/users", { headers: authHeaders });
    assert.equal(employeeList.status, 200);
    assert.ok(employeeList.body.users.every((user) => !Object.hasOwn(user, "password_hash")));
    const roleChange = await requestJson(api.baseUrl, `/api/admin/users/${staffUser.rows[0].id}/operations/change-role`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ expectedAccountVersion: 1, role: "AUDITOR" })
    });
    assert.equal(roleChange.status, 400);
    assert.equal((await requestJson(api.baseUrl, "/api/admin/users", { headers: staffHeaders })).status, 403);
    const staffSessionTwo = await createSession(db, { ...staffUser.rows[0], role: "STAFF" }, config, "phase-8-staff-test");
    const staffHeadersTwo = { Cookie: `${config.session.cookieName}=${staffSessionTwo.token}`, [config.session.csrfHeaderName]: staffSessionTwo.csrfToken };
    assert.equal((await requestJson(api.baseUrl, `/api/admin/users/${staffUser.rows[0].id}/operations/disable`, {
      method: "POST", headers: staffHeadersTwo, body: JSON.stringify({ expectedAccountVersion: 2 })
    })).status, 403);
    const selfDisable = await requestJson(api.baseUrl, `/api/admin/users/${apiUser.rows[0].id}/operations/disable`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ expectedAccountVersion: 1 })
    });
    assert.equal(selfDisable.status, 409);
    assert.equal(selfDisable.body.code, "SELF_ACCOUNT_OPERATION_NOT_ALLOWED");
    const invalidNoShow = await requestJson(api.baseUrl, `/api/reservations/${pendingNoShowId}/operations/no_show`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ expectedStatusVersion: 1 })
    });
    assert.equal(invalidNoShow.status, 409);
    const validNoShow = await requestJson(api.baseUrl, `/api/reservations/${confirmedNoShowId}/operations/no_show`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ expectedStatusVersion: 1 })
    });
    assert.equal(validNoShow.status, 200);
    assert.equal(validNoShow.body.reservation.Status, "NO_SHOW");
    const noShowAudit = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM admin_audit_logs
       WHERE action = 'RESERVATION_LIFECYCLE_TRANSITION'
         AND entity_type = 'RESERVATION'
         AND entity_id = $1
         AND metadata->>'toStatus' = 'NO_SHOW'`,
      [String(confirmedNoShowId)]
    );
    assert.equal(noShowAudit.rows[0].count, 1);
    const noShowHistory = await pool.query("SELECT id FROM reservation_status_history WHERE reservation_id = $1", [confirmedNoShowId]);
    await assert.rejects(pool.query("UPDATE reservation_status_history SET operation = 'NO_SHOW' WHERE id = $1", [noShowHistory.rows[0].id]));
    await assert.rejects(pool.query("DELETE FROM reservation_status_history WHERE id = $1", [noShowHistory.rows[0].id]));
    const removedGenericRoute = await fetch(`${api.baseUrl}/api/reservations/${confirmedNoShowId}/status`, {
      method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({ status: "CONFIRMED" })
    });
    assert.equal(removedGenericRoute.status, 404);
    const availableAfterNoShow = await requestJson(
      api.baseUrl,
      "/api/public/vehicles?pickupAt=2030-04-11T10%3A00%3A00Z&returnAt=2030-04-11T12%3A00%3A00Z"
    );
    assert.ok(availableAfterNoShow.body.vehicles.some((vehicle) => vehicle.id === noShowVehicleId));

    const integrityVehicles = await pool.query(
      `INSERT INTO vehicles (vin, make, model, year, category, dailyrate, depositamount)
       VALUES
         ($1, 'Test', 'Confirmed integrity', 2025, 'Sedan', 90, 100),
         ($2, 'Test', 'Checkout integrity', 2025, 'Sedan', 90, 100),
         ($3, 'Test', 'Nonblocking integrity', 2025, 'Sedan', 90, 100)
       RETURNING vehicleid`,
      [`P2IC${shortSuffix}`, `P2IO${shortSuffix}`, `P2IN${shortSuffix}`]
    );
    const [confirmedIntegrityId, checkoutIntegrityId, nonblockingIntegrityId] = integrityVehicles.rows.map((row) => row.vehicleid);
    await pool.query(
      `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES ($1, 'Confirmed base', $2, $3, $4, 'CONFIRMED', 90),
              ($5, 'Checkout base', $6, $3, $4, 'CHECKED_OUT', 90),
              ($7, 'Nonblocking base', $8, $3, $4, 'CONFIRMED', 90)`,
      [
        confirmedIntegrityId,
        `confirmed-base-${suffix}@example.test`,
        blockingPickup,
        blockingReturn,
        checkoutIntegrityId,
        `checkout-base-${suffix}@example.test`,
        nonblockingIntegrityId,
        `nonblocking-base-${suffix}@example.test`
      ]
    );

    await expectExclusionViolation(pool.query(
      `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES ($1, 'Conflicting checkout', $2, $3, $4, 'CHECKED_OUT', 90)`,
      [confirmedIntegrityId, `conflicting-checkout-${suffix}@example.test`, blockingPickup, blockingReturn]
    ));
    await expectExclusionViolation(pool.query(
      `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES ($1, 'Conflicting confirmation', $2, $3, $4, 'CONFIRMED', 90)`,
      [checkoutIntegrityId, `conflicting-confirmed-${suffix}@example.test`, blockingPickup, blockingReturn]
    ));

    const pendingConflict = await pool.query(
      `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES ($1, 'Pending direct update', $2, $3, $4, 'PENDING_REQUEST', 90)
       RETURNING reservationid`,
      [confirmedIntegrityId, `pending-update-${suffix}@example.test`, blockingPickup, blockingReturn]
    );
    await expectExclusionViolation(pool.query(
      "UPDATE reservationsmvp SET status = 'CHECKED_OUT' WHERE reservationid = $1",
      [pendingConflict.rows[0].reservationid]
    ));
    const unchangedPending = await pool.query("SELECT status FROM reservationsmvp WHERE reservationid = $1", [pendingConflict.rows[0].reservationid]);
    assert.equal(unchangedPending.rows[0].status, "PENDING_REQUEST");

    const nonBlockingStatuses = ["PENDING_REQUEST", "DECLINED", "CANCELLED", "COMPLETED", "NO_SHOW"];
    for (const status of nonBlockingStatuses) {
      await pool.query(
        `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
         VALUES ($1, $2, $3, $4, $5, $6, 90)`,
        [nonblockingIntegrityId, `${status} overlap`, `${status.toLowerCase()}-${suffix}@example.test`, blockingPickup, blockingReturn, status]
      );
    }
    const nonBlockingCount = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM reservationsmvp WHERE vehicleid = $1 AND status = ANY($2::text[])",
      [nonblockingIntegrityId, nonBlockingStatuses]
    );
    assert.equal(nonBlockingCount.rows[0].count, nonBlockingStatuses.length);
    const adjacentBlocking = await pool.query(
      `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES ($1, 'Adjacent confirmation', $2, $3, $4, 'CONFIRMED', 90)
       RETURNING reservationid`,
      [nonblockingIntegrityId, `adjacent-confirmed-${suffix}@example.test`, blockingReturn, "2030-01-14T10:00:00Z"]
    );
    assert.equal(adjacentBlocking.rowCount, 1);

    const operationalVehicles = await pool.query(
      `INSERT INTO vehicles (vin, make, model, year, category, dailyrate, depositamount, status)
       VALUES
         ($1, 'Test', 'Maintenance', 2025, 'Sedan', 90, 100, 'MAINTENANCE'),
         ($2, 'Test', 'Out of service', 2025, 'Sedan', 90, 100, 'OUT_OF_SERVICE'),
         ($3, 'Test', 'Retired', 2025, 'Sedan', 90, 100, 'RETIRED')
       RETURNING vehicleid, status`,
      [`P2MAINT${shortSuffix}`, `P2OOS${shortSuffix}`, `P2RET${shortSuffix}`]
    );
    for (const vehicle of operationalVehicles.rows) {
      const pending = await pool.query(
        `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
         VALUES ($1, $2, $3, $4, $5, 'PENDING_REQUEST', 90)
         RETURNING reservationid`,
        [vehicle.vehicleid, `${vehicle.status} customer`, `${vehicle.status.toLowerCase()}-${suffix}@example.test`, blockingPickup, blockingReturn]
      );
      const response = await requestJson(api.baseUrl, `/api/reservations/${pending.rows[0].reservationid}/operations/confirm`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ expectedStatusVersion: 1 })
      });
      assert.equal(response.status, 409);
      const unchanged = await pool.query("SELECT status FROM reservationsmvp WHERE reservationid = $1", [pending.rows[0].reservationid]);
      assert.equal(unchanged.rows[0].status, "PENDING_REQUEST");
    }

    const concurrencyVehicle = await pool.query(
      `INSERT INTO vehicles (vin, make, model, year, category, dailyrate, depositamount)
       VALUES ($1, 'Test', 'Concurrent API', 2025, 'Sedan', 90, 100)
       RETURNING vehicleid`,
      [`P2CONC${shortSuffix}`]
    );
    const concurrencyVehicleId = concurrencyVehicle.rows[0].vehicleid;
    const pendingReservations = await pool.query(
      `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES ($1, 'Concurrent one', $2, $3, $4, 'PENDING_REQUEST', 90),
              ($1, 'Concurrent two', $5, $3, $4, 'PENDING_REQUEST', 90)
       RETURNING reservationid`,
      [
        concurrencyVehicleId,
        `concurrent-one-${suffix}@example.test`,
        blockingPickup,
        blockingReturn,
        `concurrent-two-${suffix}@example.test`
      ]
    );

    concurrencyBlocker = await pool.connect();
    await concurrencyBlocker.query("BEGIN");
    await concurrencyBlocker.query("SELECT * FROM vehicles WHERE vehicleid = $1 FOR UPDATE", [concurrencyVehicleId]);
    const confirmations = pendingReservations.rows.map((reservation) => requestJson(
      api.baseUrl,
      `/api/reservations/${reservation.reservationid}/operations/confirm`,
      { method: "POST", headers: authHeaders, body: JSON.stringify({ expectedStatusVersion: 1 }) }
    ));
    assert.equal(await waitForConcurrentVehicleLockWaiters(pool), true, "both API confirmations must reach the database barrier concurrently");
    await concurrencyBlocker.query("COMMIT");
    concurrencyBlocker.release();
    concurrencyBlocker = null;

    const confirmationResults = await Promise.all(confirmations);
    assert.deepEqual(confirmationResults.map((result) => result.status).sort(), [200, 409]);
    assert.equal(confirmationResults.find((result) => result.status === 409).body.code, "RESERVATION_STATE_CONFLICT");
    const finalStatuses = await pool.query(
      "SELECT status FROM reservationsmvp WHERE reservationid = ANY($1::integer[]) ORDER BY status",
      [pendingReservations.rows.map((row) => row.reservationid)]
    );
    assert.deepEqual(finalStatuses.rows.map((row) => row.status), ["CONFIRMED", "PENDING_REQUEST"]);
    const blockingOverlapCount = await pool.query(
      `SELECT COUNT(*)::integer AS overlaps
       FROM reservationsmvp earlier
       JOIN reservationsmvp later ON later.vehicleid = earlier.vehicleid
         AND later.reservationid > earlier.reservationid
         AND tstzrange(earlier.pickupat, earlier.returnat, '[)') && tstzrange(later.pickupat, later.returnat, '[)')
       WHERE earlier.vehicleid = $1
         AND UPPER(earlier.status) IN ('CONFIRMED', 'CHECKED_OUT')
         AND UPPER(later.status) IN ('CONFIRMED', 'CHECKED_OUT')`,
      [concurrencyVehicleId]
    );
    assert.equal(blockingOverlapCount.rows[0].overlaps, 0);

    const lifecycleVehicle = await pool.query(
      `INSERT INTO vehicles (vin, make, model, year, category, dailyrate, depositamount)
       VALUES ($1, 'Test', 'Lifecycle', 2025, 'Sedan', 90, 100) RETURNING vehicleid`,
      [`P7LIFE${shortSuffix}`]
    );
    const lifecycleReservation = await pool.query(
      `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES ($1, 'Lifecycle customer', $2, '2031-01-10T10:00:00Z', '2031-01-12T10:00:00Z', 'PENDING_REQUEST', 90)
       RETURNING reservationid`,
      [lifecycleVehicle.rows[0].vehicleid, `lifecycle-${suffix}@example.test`]
    );
    const lifecycleId = lifecycleReservation.rows[0].reservationid;
    let checkoutEvidenceCounter = 0;
    // Staff confirm license, insurance and the signed paper agreement at the counter.
    async function addCheckoutPrerequisites(reservationId) {
      const response = await requestJson(api.baseUrl, `/api/reservations/${reservationId}/counter/checks`, {
        method: "PATCH", headers: authHeaders, body: JSON.stringify({ checks: { license: true, insurance: true, agreement: true } })
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.counter.checks.complete, true);
    }
    const operationFor = (reservationId, name, version) => requestJson(api.baseUrl, `/api/reservations/${reservationId}/operations/${name}`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ expectedStatusVersion: version })
    });
    const operation = (name, version) => operationFor(lifecycleId, name, version);
    for (const [name, version, status] of [["confirm", 1, "CONFIRMED"], ["ready_for_pickup", 2, "READY_FOR_PICKUP"]]) {
      const response = await operation(name, version);
      assert.equal(response.status, 200);
      assert.equal(response.body.reservation.Status, status);
      assert.equal(response.body.reservation.StatusVersion, version + 1);
    }
    const inspectionPath = `/api/reservations/${lifecycleId}/inspections/pickup`;
    const inspectionBody = { odometer: 100, fuelLevelPercent: 80, damageObserved: false, keysCount: 2, cleanlinessNotes: "Clean" };
    assert.equal((await requestJson(api.baseUrl, inspectionPath, { method: "POST", body: JSON.stringify(inspectionBody) })).status, 401);
    assert.equal((await requestJson(api.baseUrl, inspectionPath, { method: "POST", headers: { Cookie: authHeaders.Cookie, [config.session.csrfHeaderName]: "wrong" }, body: JSON.stringify(inspectionBody) })).status, 403);
    assert.equal((await requestJson(api.baseUrl, inspectionPath, { method: "POST", headers: staffHeaders, body: JSON.stringify({}) })).status, 400);
    const inspection = (type, body) => requestJson(api.baseUrl, `/api/reservations/${lifecycleId}/inspections/${type}`, { method: "POST", headers: authHeaders, body: JSON.stringify(body) });
    const blockedCheckout = await operation("check_out", 3);
    assert.equal(blockedCheckout.status, 409);
    assert.equal(blockedCheckout.body.code, "COUNTER_CHECKS_REQUIRED");
    await addCheckoutPrerequisites(lifecycleId);
    const inspectionBlockedCheckout = await operation("check_out", 3);
    assert.equal(inspectionBlockedCheckout.status, 409);
    assert.equal(inspectionBlockedCheckout.body.code, "PICKUP_INSPECTION_REQUIRED");
    const pickupInspection = await inspection("pickup", inspectionBody);
    assert.equal(pickupInspection.status, 201);
    assert.equal((await operation("check_out", 3)).status, 200);
    assert.equal((await operation("mark_returned", 4)).status, 200);
    const blockedComplete = await operation("complete", 5);
    assert.equal(blockedComplete.status, 409);
    assert.equal(blockedComplete.body.code, "RETURN_INSPECTION_REQUIRED");
    const returnInspection = await inspection("return", { odometer: 125, fuelLevelPercent: 70, damageObserved: true, damageNotes: "Small new scratch", keysCount: 2, allExpectedKeysReturned: true, accessoriesReturned: true });
    assert.equal(returnInspection.status, 201);
    const unpaidComplete = await operation("complete", 5);
    assert.equal(unpaidComplete.status, 409);
    assert.equal(unpaidComplete.body.code, "BALANCE_DUE");
    const counter = await requestJson(api.baseUrl, `/api/reservations/${lifecycleId}/counter`, { headers: authHeaders });
    const paid = await requestJson(api.baseUrl, `/api/reservations/${lifecycleId}/payments`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ kind: "PAYMENT", method: "CASH", amountCents: counter.body.counter.ledger.balanceCents })
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.equal(paid.body.counter.ledger.settled, true);
    const overRefund = await requestJson(api.baseUrl, `/api/reservations/${lifecycleId}/payments`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ kind: "REFUND", method: "CASH", amountCents: paid.body.counter.ledger.paidCents + 1 })
    });
    assert.equal(overRefund.body.code, "REFUND_TOO_LARGE");
    await assert.rejects(pool.query("UPDATE rental_payments SET amount_cents = 1 WHERE reservation_id = $1", [lifecycleId]));
    await assert.rejects(pool.query("DELETE FROM rental_payments WHERE reservation_id = $1", [lifecycleId]));
    assert.equal((await operation("complete", 5)).status, 200);
    const lifecycleHistory = await pool.query("SELECT from_status, to_status, status_version FROM reservation_status_history WHERE reservation_id = $1 ORDER BY status_version", [lifecycleId]);
    assert.equal(lifecycleHistory.rowCount, 5);
    assert.deepEqual(lifecycleHistory.rows.map((row) => row.to_status), ["CONFIRMED", "READY_FOR_PICKUP", "CHECKED_OUT", "RETURNED_PENDING_INSPECTION", "COMPLETED"]);
    assert.equal((await pool.query("SELECT mileage FROM vehicles WHERE vehicleid = $1", [lifecycleVehicle.rows[0].vehicleid])).rows[0].mileage, 125);
    await assert.rejects(pool.query("UPDATE rental_inspections SET odometer = 1 WHERE reservation_id = $1", [lifecycleId]));
    await assert.rejects(pool.query("DELETE FROM rental_inspections WHERE reservation_id = $1", [lifecycleId]));

    const inspectionRaceReservation = await pool.query(
      `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES ($1, 'Inspection race', $2, '2031-03-10T10:00:00Z', '2031-03-12T10:00:00Z', 'READY_FOR_PICKUP', 90) RETURNING reservationid`,
      [lifecycleVehicle.rows[0].vehicleid, `inspection-race-${suffix}@example.test`]
    );
    const inspectionRaceId = inspectionRaceReservation.rows[0].reservationid;
    const pickupRace = () => requestJson(api.baseUrl, `/api/reservations/${inspectionRaceId}/inspections/pickup`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ odometer: 150, fuelLevelPercent: 90, damageObserved: false, keysCount: 2 })
    });
    const pickupRaceResults = await Promise.all([pickupRace(), pickupRace()]);
    assert.deepEqual(pickupRaceResults.map((entry) => entry.status).sort(), [201, 409]);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM rental_inspections WHERE reservation_id = $1", [inspectionRaceId])).rows[0].count, 1);
    await addCheckoutPrerequisites(inspectionRaceId);
    assert.equal((await operationFor(inspectionRaceId, "check_out", 1)).status, 200);
    assert.equal((await operationFor(inspectionRaceId, "mark_returned", 2)).status, 200);
    const returnRace = () => requestJson(api.baseUrl, `/api/reservations/${inspectionRaceId}/inspections/return`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ odometer: 175, fuelLevelPercent: 75, damageObserved: false, keysCount: 2, allExpectedKeysReturned: true, accessoriesReturned: true })
    });
    const returnRaceResults = await Promise.all([returnRace(), returnRace()]);
    assert.deepEqual(returnRaceResults.map((entry) => entry.status).sort(), [201, 409]);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM rental_inspections WHERE reservation_id = $1", [inspectionRaceId])).rows[0].count, 2);

    const concurrentLifecycle = await pool.query(
      `INSERT INTO reservationsmvp (vehicleid, customername, customeremail, pickupat, returnat, status, estimatedtotal)
       VALUES ($1, 'Concurrent lifecycle', $2, '2031-02-10T10:00:00Z', '2031-02-12T10:00:00Z', 'PENDING_REQUEST', 90) RETURNING reservationid`,
      [lifecycleVehicle.rows[0].vehicleid, `concurrent-lifecycle-${suffix}@example.test`]
    );
    const concurrentLifecycleId = concurrentLifecycle.rows[0].reservationid;
    const concurrentOperation = (name, version) => requestJson(api.baseUrl, `/api/reservations/${concurrentLifecycleId}/operations/${name}`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ expectedStatusVersion: version })
    });
    const duplicateConfirmation = await Promise.all([concurrentOperation("confirm", 1), concurrentOperation("confirm", 1)]);
    assert.deepEqual(duplicateConfirmation.map((entry) => entry.status).sort(), [200, 409]);
    const competingTransitions = await Promise.all([concurrentOperation("ready_for_pickup", 2), concurrentOperation("cancel", 2)]);
    assert.deepEqual(competingTransitions.map((entry) => entry.status).sort(), [200, 409]);
    const concurrentFinal = await pool.query("SELECT status, statusversion FROM reservationsmvp WHERE reservationid = $1", [concurrentLifecycleId]);
    assert.ok(["READY_FOR_PICKUP", "CANCELLED"].includes(concurrentFinal.rows[0].status));
    assert.equal(concurrentFinal.rows[0].statusversion, 3);
    const concurrentHistory = await pool.query("SELECT COUNT(*)::integer AS count FROM reservation_status_history WHERE reservation_id = $1", [concurrentLifecycleId]);
    assert.equal(concurrentHistory.rows[0].count, 2);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM notification_outbox WHERE reservation_id = $1 AND event_type = 'RESERVATION_CONFIRMED'", [concurrentLifecycleId])).rows[0].count, 1);

    await t.test("advisory-lock serialization prevents concurrent owner removal from leaving zero active owners", async () => {
      const owners = await pool.query(
        `INSERT INTO admin_users (email, password_hash, role) VALUES
          ($1, 'owner-a-fixture', 'OWNER'), ($2, 'owner-b-fixture', 'OWNER') RETURNING id`,
        [`owner-a-${suffix}@example.test`, `owner-b-${suffix}@example.test`]
      );
      // Leave exactly the two targets active. The service still records a valid
      // actor audit identity; route-level active OWNER authorization is tested above.
      await pool.query("UPDATE admin_users SET is_active = FALSE WHERE id = $1", [apiUser.rows[0].id]);
      const [ownerA, ownerB] = owners.rows;
      const actor = { id: apiUser.rows[0].id, role: "OWNER" };
      const outcomes = await Promise.allSettled([
        mutateAdminUser({ database: db, actor, userId: ownerA.id, operation: "DISABLE", expectedAccountVersion: 1 }),
        mutateAdminUser({ database: db, actor, userId: ownerB.id, operation: "CHANGE_ROLE", expectedAccountVersion: 1, role: "STAFF" })
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      assert.equal(rejected.reason.code, "LAST_ACTIVE_OWNER_REQUIRED");
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM admin_users WHERE is_active AND role = 'OWNER'")).rows[0].count, 1);
    });
  } finally {
    if (concurrencyBlocker) {
      await concurrencyBlocker.query("ROLLBACK").catch(() => undefined);
      concurrencyBlocker.release();
    }
    await api?.close();
    await db.end();
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.end();
  }
});
