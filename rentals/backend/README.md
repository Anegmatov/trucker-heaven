# Trucker Heaven Rentals backend

Express + PostgreSQL backend for the rentals booking site. PostgreSQL is the only production database supported.

## Module layout

This backend is written to be mounted as one module inside a shared Express process (see `MERGE-NOTES.md`):

- `app.js` builds and exports the Express app with all middleware and routes. Requiring it has no side effects beyond reading `RENTALS_*` env.
- `startup.js` exports `init()` (connection check + pending migrations), `runMigrations(databaseUrl)` (idempotent) and `shutdown()`.
- `server.js` is the standalone entry: loads `.env`, calls `init()`, then `listen(PORT)`.
- `db/connection.js` holds the single lazily created pool, built from `RENTALS_DATABASE_URL`.
- Every env var is prefixed `RENTALS_`; `PORT` and `NODE_ENV` are the only unprefixed names. Paths are resolved relative to this folder, never the process cwd.
- Root status is `GET /health`; liveness/readiness stay at `/api/health/live` and `/api/health/ready`.

Pinned dependency majors (exact versions installed): express 5.2.1, pg 8.22.0, express-rate-limit 8.5.2, helmet 8.3.0, cors 2.8.6, multer 2.2.0, bcrypt 6.0.0, dotenv 17.4.2. No JWT library is used; admin sessions are opaque tokens stored in PostgreSQL.

## Local setup

Install PostgreSQL 14+ and create a local role/database:

```bash
sudo -u postgres createuser --pwprompt driveops
sudo -u postgres createdb --owner=driveops driveops
cd backend
npm install
cp .env.example .env
npm run migrate
npm run dev
```

On platforms where `sudo -u postgres` is unavailable, use an equivalent PostgreSQL administrator account. The API listens on `PORT` (default `3000`).

## Environment

`RENTALS_DATABASE_URL` is preferred when a provider supplies it. Otherwise configure all of `RENTALS_PGHOST`, `RENTALS_PGPORT`, `RENTALS_PGDATABASE`, `RENTALS_PGUSER`, and `RENTALS_PGPASSWORD`.

```env
RENTALS_DATABASE_URL=
RENTALS_PGHOST=localhost
RENTALS_PGPORT=5432
RENTALS_PGDATABASE=driveops
RENTALS_PGUSER=driveops
RENTALS_PGPASSWORD=your_password_here
RENTALS_PGSSLMODE=
RENTALS_DATABASE_SSL=false
RENTALS_DATABASE_SSL_REJECT_UNAUTHORIZED=true
RENTALS_PGPOOL_MAX=10
RENTALS_TRUST_PROXY=0
RENTALS_CORS_ALLOWED_ORIGINS=http://localhost:5174,http://localhost:5175
RENTALS_JSON_BODY_LIMIT=1mb
RENTALS_RATE_LIMIT_WINDOW_MS=900000
RENTALS_RATE_LIMIT_MAX=300
RENTALS_RESERVATION_RATE_LIMIT_WINDOW_MS=3600000
RENTALS_RESERVATION_RATE_LIMIT_MAX=10
RENTALS_ADMIN_RATE_LIMIT_WINDOW_MS=900000
RENTALS_ADMIN_RATE_LIMIT_MAX=120
```

Set `RENTALS_DATABASE_SSL=true` for a provider requiring TLS. Certificate verification remains enabled by default; only set `RENTALS_DATABASE_SSL_REJECT_UNAUTHORIZED=false` when the provider explicitly requires that exception.

`RENTALS_CORS_ALLOWED_ORIGINS` must be explicitly non-empty in production and may contain multiple comma-separated browser origins. For the deployed frontends set it exactly to `https://rentals.truckerheaven.com,https://rentals-admin.truckerheaven.com`; customer and admin are separate browser origins, while the parent website does not need credentialed API access. `RENTALS_TRUST_PROXY=1` is appropriate only when the API is behind one known reverse proxy; verify that proxy topology before enabling it so secure-cookie behavior remains trustworthy. The existing admin, upload, office, and Twilio variables remain in `.env.example`. Do not commit a real `.env` file.

### Production environment and persistent uploads

Use placeholders only when configuring a production platform; keep real secrets in that platform's secret store.

```env
NODE_ENV=production
PORT=<platform-provided>
RENTALS_DATABASE_URL=<driveops production database URL>
RENTALS_DATABASE_SSL=<appropriate managed-database value>
RENTALS_DATABASE_SSL_REJECT_UNAUTHORIZED=<platform-appropriate value>
RENTALS_TRUST_PROXY=1
RENTALS_CORS_ALLOWED_ORIGINS=https://rentals.truckerheaven.com,https://rentals-admin.truckerheaven.com
RENTALS_SESSION_COOKIE_NAME=driveops_admin_session
RENTALS_SESSION_TOKEN_PEPPER=<long random production secret>
RENTALS_COOKIE_SECURE=true
RENTALS_COOKIE_SAME_SITE=lax
RENTALS_SESSION_TTL_SECONDS=28800
RENTALS_PUBLIC_BASE_URL=https://rentals-api.truckerheaven.com
RENTALS_VEHICLE_UPLOAD_DIR=/var/data/driveops/vehicles
RENTALS_RENTAL_UPLOAD_DIR=/var/data/driveops/rentals-private
RENTALS_RENTAL_PAYMENT_MODE=PAY_AT_LOCATION
RENTALS_SMS_ENABLED=false
RENTALS_RENTAL_OFFICE_NAME=Trucker Heaven Rentals
RENTALS_RENTAL_OFFICE_ADDRESS=8037 Eastgate Blvd, Mt. Juliet, TN 37122
RENTALS_RENTAL_OFFICE_PHONE=615-470-5075
```

Mount one persistent disk at `/var/data/driveops`. Vehicle photos are written to `/var/data/driveops/vehicles` and served through the controlled public route `/uploads/vehicles/<filename>`. Rental licenses and insurance documents are written to `/var/data/driveops/rentals-private`; they are never mounted as static content and remain available only through authorized document download routes. A normal ephemeral service filesystem is not sufficient for either runtime upload directory.

Admin session cookies stay host-only on `rentals-api.truckerheaven.com` and scoped to `/api`. HTTPS and `RENTALS_COOKIE_SECURE=true` are required in production. `PAY_AT_LOCATION` is accepted as a deployment-facing alias and remains the stable API/database value `PAY_AT_PICKUP` internally.

## Admin authentication

Admin API access uses opaque server-side sessions. The browser receives only an HttpOnly cookie; PostgreSQL stores a SHA-256 hash of the opaque token and CSRF token hash. Passwords use bcrypt with cost 12. Login failures use a generic response and repeated failures lock the account according to `RENTALS_ADMIN_LOCKOUT_THRESHOLD` and `RENTALS_ADMIN_LOCKOUT_SECONDS`.

Create the initial owner only after applying migrations to the intended database:

```bash
cd backend
npm run admin:create
```

The command prompts for an email and password and requires at least 12 characters containing upper-case, lower-case, and numeric characters. It never runs during API startup. In production set a unique `RENTALS_SESSION_TOKEN_PEPPER`, `RENTALS_COOKIE_SECURE=true`, and an appropriate `RENTALS_COOKIE_SAME_SITE` value; cross-site cookies require `RENTALS_COOKIE_SAME_SITE=none` and HTTPS. The session cookie is `HttpOnly`, host-only, and scoped to `/api`; do not broaden its domain.

To rotate an existing admin password, use the operator-only reset command with both an explicit username and a new protected credential-file path:

```bash
cd backend
npm run admin:reset-password -- --username owner.local@driveops.test --output-file /home/aziz/DriveOps-local-credentials/owner-YYYYMMDD-HHMMSS.txt
```

It never creates accounts or exposes the generated password in terminal output. It updates only the named existing admin, clears its failed-login lockout state, and revokes all of that admin's active sessions in the same database transaction. The output file is created only if it does not already exist. On POSIX systems the existing parent directory must not be world-accessible and the file is verified as mode `0600`; on Windows the file receives a non-inherited ACL granting only the current operator full control. If file protection fails, the reserved file is removed before any database change. The file contains only the username and temporary password; never commit it. After a successful manual login, remove obsolete credential files using your normal protected local-credential process. This is an operator command, not a public API or employee-management feature. No password-reset audit event is created because the current audit schema records an administrator actor and this offline command has no authenticated operator identity.

Create a STAFF employee with the separate operator command; `admin:create` remains the initial OWNER bootstrap command and cannot create employees:

```bash
cd backend
npm run admin:create-employee -- --username staff.local@driveops.test --role STAFF --output-file /home/aziz/DriveOps-local-credentials/staff-YYYYMMDD-HHMMSS.txt
```

The command accepts only `STAFF`, requires every argument explicitly, creates an active account with account version `1`, and creates no session. It generates a temporary password using the configured bcrypt cost, writes it only to a newly protected credential file using the platform rules described above, and prints only the username, role, and credential-file path. It refuses OWNER, duplicate usernames, and existing output files. Browser employee APIs never create accounts or reveal passwords; browser controls are limited to OWNER-operated role changes, disable/enable, and session revocation. The offline command records no admin audit event because it has no authenticated operator actor. Keep credential files outside Git.

## Migrations

`npm run migrate` uses `schema_migrations` to apply each numbered SQL file exactly once, under a PostgreSQL advisory lock. It never drops or recreates tables and exits non-zero when a migration fails. The same idempotent routine runs from `init()` at startup (see `startup.js`), so repeated starts are safe.

`004_reservation_availability.sql` separates vehicle operational condition (`READY`, `MAINTENANCE`, `OUT_OF_SERVICE`, `RETIRED`) from reservation availability. It maps legacy statuses safely, stops with a clear error if existing blocking reservations overlap, and adds a PostgreSQL `tstzrange` exclusion constraint for `CONFIRMED` and `CHECKED_OUT` reservations. Do not apply it until existing conflicts have been reviewed.

Customer date/time fields are America/Chicago wall times. The API converts unqualified timestamps using that timezone, accepts timestamp values with explicit offsets, rejects nonexistent daylight-saving times, and stores every value as `TIMESTAMPTZ`. Reservation intervals are half-open: `[pickupAt, returnAt)`, so a return exactly at another pickup is permitted.

The application and migrations use PostgreSQL's `public` schema. The readiness endpoint requires `public.vehicles`, `public.vehiclephotos`, and `public.reservationsmvp`; an unmigrated database therefore returns HTTP 503 from `/api/health/ready`.

For Render or a comparable host, `npm start` runs `init()` (connection check + pending migrations) and then listens. `npm run migrate` remains available as a standalone release step.

## Checks

```bash
cd backend
npm run migrate
npm run check
npm test
```

The schema comprises:

- `001_driveops_mvp.sql` — vehicles, vehicle photos, and reservations.
- `002_legacy_compatibility.sql` — historical class-project tables (customers, cars, rental, paymentdetails) and the `rentaldetails` view; kept as history.
- `009_food_owner_staff.sql` — food ordering tables; kept as history.
- `013_drop_food_and_legacy.sql` — drops the food tables, the legacy tables and the `rentaldetails` view. Food ordering lives in its own module now; the legacy API was removed.

Timestamps are `TIMESTAMPTZ`, monetary amounts are `NUMERIC(10,2)`, and photo primary flags are native `BOOLEAN` values.

## Tests

`npm test` always runs the test suite. PostgreSQL integration checks are skipped unless `RENTALS_TEST_DATABASE_URL` points to a non-production test database:

```bash
RENTALS_TEST_DATABASE_URL=postgresql://driveops:password@localhost:5432/driveops_test npm test
```

## Phase 7A lifecycle integrity

Migration `006_rental_operations_lifecycle.sql` adds `READY_FOR_PICKUP` and `RETURNED_PENDING_INSPECTION`, `statusversion`, and append-only `reservation_status_history`. The permitted lifecycle is `PENDING_REQUEST → CONFIRMED → READY_FOR_PICKUP → CHECKED_OUT → RETURNED_PENDING_INSPECTION → COMPLETED`, with only the documented decline, cancellation, and no-show alternatives. `COMPLETED`, `DECLINED`, `CANCELLED`, and `NO_SHOW` are terminal.

Lifecycle operations are named server routes, require an authenticated OWNER or STAFF plus CSRF validation, and compare `expectedStatusVersion` under a database transaction. A stale or incompatible change returns `409` with `RESERVATION_STATE_CONFLICT`; it neither creates history nor enqueues a notification. Transition history, the reservation update, the admin audit event, and any supported outbox event commit together; the worker sends only after commit.

Readiness requires migration 006, the version column, validated history foreign keys, immutable history trigger, and a valid exclusion constraint covering `CONFIRMED`, `READY_FOR_PICKUP`, `CHECKED_OUT`, and `RETURNED_PENDING_INSPECTION`. Run destructive migration tests only with an explicitly disposable PostgreSQL 16 `RENTALS_TEST_DATABASE_URL`; never apply migration 006 to a preserved local database without review. This phase does not make the platform ready for real checkout.

## Phase 7C rental inspections

Migration `007_rental_inspections.sql` adds immutable internal pickup and return evidence. OWNER and STAFF may complete one pickup inspection only at `READY_FOR_PICKUP` and one return inspection only at `RETURNED_PENDING_INSPECTION`; checkout and completion respectively require that evidence. Inspections record odometer, fuel percentage, damage observation and notes, cleanliness, keys, accessories, inspecting admin, and timestamps. This phase has no photos/uploads, fees, payment/deposit outcomes, insurance decisions, signatures, legal conclusions, or agreement workflow. Test migration 007 only against disposable PostgreSQL 16.

That test applies tracked migrations and rolls back its inserted test data. It covers connection/migration setup, generated IDs, vehicle CRUD behavior, timestamps, boolean handling, reservation conflict queries, case-insensitive customer lookup, transaction rollback, unique constraints, and `ON CONFLICT` behavior.

## Existing MySQL data

For a safe one-time data migration, follow [the MySQL-to-PostgreSQL guide](docs/mysql-to-postgres.md). The guide intentionally does not connect to, modify, or embed credentials for a live source database.

## File uploads and SMS

Vehicle photos default locally to `uploads/vehicles`; set `RENTALS_VEHICLE_UPLOAD_DIR` to change only the physical directory while preserving `uploads/vehicles/<filename>` storage keys and public URLs. For the initial production persistent disk, use `/var/data/driveops/vehicles`; managed object storage can be adopted later without changing the public route contract.

Reservation SMS is optional and durable. Migration `008_durable_notifications_admin_controls.sql` atomically queues existing reservation-created, confirmed, and declined SMS events; it does not call a provider inside a reservation transaction. Run the separate worker after migrations:

```bash
npm run notifications:worker
```

The worker uses row locks, an expiring lease, append-only attempts, and bounded exponential retry (`RENTALS_NOTIFICATION_MAX_ATTEMPTS`, `RENTALS_NOTIFICATION_INITIAL_DELAY_MS`, `RENTALS_NOTIFICATION_MAX_DELAY_MS`, and `RENTALS_NOTIFICATION_LEASE_MS`). A configured provider acceptance is the only condition that records `SENT`. Twilio's current request path does not provide a proven application idempotency key, so delivery is at-least-once across a crash after provider acceptance. A timeout or transport loss after a request may have been transmitted is instead recorded as `DEAD_LETTER` with `DELIVERY_OUTCOME_UNKNOWN` and is not automatically resent; reconcile it with the provider before any operator action. A missing provider records a single `SKIPPED` attempt with `PROVIDER_NOT_CONFIGURED`; no customer-facing API says that an SMS was sent in that case. Logs and API responses omit message bodies, phone numbers, provider payloads, and provider credentials.

Migration 008 also adds account versions and disable metadata. `GET /api/admin/users` returns safe employee data; the named role-change, disable, enable, and session-revoke operations are authenticated, CSRF-protected, and OWNER-only. They use optimistic account versions, revoke affected sessions where required, write an audit entry, protect the last active OWNER, and prohibit self-account operations. Browser APIs never create/reset passwords; use only `npm run admin:create`, `npm run admin:create-employee`, and `npm run admin:reset-password`.
