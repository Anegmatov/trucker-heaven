# Parking API — merge notes

How this backend is shaped so it can be mounted as one module inside the shared
Trucker Heaven Express app (one Render service routing parking, rentals, food and
time clock by hostname). The merge itself happens in the parent repo.

## What `app.js` exports

`require('./app')` returns the Express application with every middleware and route
already registered. Requiring it has **no side effects**: no database connection,
no migrations, no timers. Properties on the export:

| Export | What it is |
| --- | --- |
| `app` (default) | The Express app. Mount it with `parent.use(app)` or wrap it in `http.createServer`. |
| `app.init({ migrate = true, log })` | `async`. Checks the database connection (`SELECT 1`) and runs pending migrations. Memoised: safe to call more than once. |
| `app.runMigrations(databaseUrl \| pool, { log })` | `async`, idempotent. Applies every unapplied `migrations/NNN_*.sql` inside `schema_migrations`. With a URL it opens and closes its own short-lived pool. |
| `app.startBackgroundJobs()` | Starts the periodic sweep (`setInterval`, `unref`'d) and runs it once. Call after `init()`. |
| `app.stopBackgroundJobs()` | Clears the sweep timer. |
| `app.sweep()` | One run of the sweep, for a parent-owned scheduler. |
| `app.close()` | Stops jobs and ends the pool. |
| `app.pool` | The module's single `pg.Pool`. |
| `app.config` | The frozen config object built from the environment. |

`server.js` is the standalone entry: `app.init()` → `app.listen(PORT)` → `app.startBackgroundJobs()`,
with SIGTERM/SIGINT shutdown. A parent app never requires `server.js`.

## What `init()` does

1. `await pool.query('SELECT 1')` — fails fast when `PARKING_DATABASE_URL` is wrong.
2. `await runMigrations(pool)` — applies pending migrations (skipped with `{ migrate: false }`).

The background sweep (started separately) expires pending bookings and quote holds,
releases ended subscriptions, cleans expired lookup grants / document grants /
admin sessions, dispatches the notification outbox, and (at most
every 10 minutes) rolls pay-on-site Monthly charges forward. Interval:
`PARKING_PENDING_EXPIRY_INTERVAL_MS` (default 60 000 ms).

## Migration command

```bash
npm run migrate            # node migrations/run.js — uses PARKING_DATABASE_URL
```

Programmatic: `require('./migrations').runMigrations(url)` or `app.runMigrations(url)`.
Migrations live in `backend/migrations/*.sql`, are tracked in `schema_migrations`,
each applied in its own transaction, and the runner refuses the `ifta_db` database.

## Database

One database, one pool. `db.js` builds the pool from `PARKING_DATABASE_URL` through
`databaseConnection.js` (SSL policy for Render internal/external hosts) and exports
it; every route and service imports that pool. All tables belong to this module
(`parking_*`, plus `schema_migrations`). Development default when the variable is
unset: `postgres://localhost:5432/parkingops`; production requires it.

## Environment variables

Every variable is read through `env.js`, which prefixes `PARKING_`. `PORT` (server.js
only) and the Node convention `NODE_ENV` are the only unprefixed ones. Render's own
`RENDER_GIT_COMMIT` / `RENDER_SERVICE_ID` / `RENDER_DEPLOY_ID` are echoed by `/ready`
if present. `.env` is loaded from the module folder (`backend/.env`), never from the
working directory.

Required in production: `PARKING_DATABASE_URL`, `PARKING_SESSION_TOKEN_PEPPER` (≥32
chars), `PARKING_COOKIE_SECURE=true`, `PARKING_CUSTOMER_COOKIE_SECURE=true`,
`PARKING_CORS_ALLOWED_ORIGINS`, `PARKING_CUSTOMER_LOOKUP_PEPPER` (or the session pepper).

| Variable | Purpose (default) |
| --- | --- |
| `PARKING_DATABASE_URL` | PostgreSQL connection string for this module's database |
| `PARKING_DATABASE_SSL` | Force TLS on/off for hosts that are not self-describing (unset = policy by host) |
| `PARKING_TRUST_PROXY_HOPS` | `app.set('trust proxy', n)` on this app instance (1 in production, else 0) |
| `PARKING_CORS_ALLOWED_ORIGINS` | Comma list of browser origins (localhost 5180/5181) |
| `PARKING_CUSTOMER_APP_URL`, `PARKING_ADMIN_APP_URL` | Absolute URLs of the two front ends (links in emails, Stripe return URLs) |
| `PARKING_JSON_BODY_LIMIT` | JSON body limit (`100kb`) |
| `PARKING_SESSION_COOKIE_NAME`, `PARKING_COOKIE_SECURE`, `PARKING_COOKIE_SAME_SITE`, `PARKING_SESSION_TTL_SECONDS`, `PARKING_SESSION_TOKEN_PEPPER` | Staff session cookie |
| `PARKING_ADMIN_LOGIN_RATE_LIMIT_MAX`, `PARKING_ADMIN_LOCKOUT_THRESHOLD`, `PARKING_ADMIN_LOCKOUT_SECONDS` | Staff sign-in limits |
| `PARKING_CUSTOMER_COOKIE_SECURE`, `PARKING_CUSTOMER_COOKIE_SAME_SITE`, `PARKING_CUSTOMER_LOOKUP_COOKIE_NAME`, `PARKING_CUSTOMER_LOOKUP_COOKIE_PATH_PREFIX` (e.g. `/parking-api` when proxied by the main site), `PARKING_CUSTOMER_LOOKUP_PEPPER` (falls back to the session pepper), `PARKING_CUSTOMER_LOOKUP_TTL_SECONDS`, `PARKING_CUSTOMER_LOOKUP_RATE_LIMIT_MAX`, `PARKING_CUSTOMER_LOOKUP_RATE_LIMIT_WINDOW_SECONDS` | My Parking / Upload Documents email+phone lookup grant (the only customer sign-in; the OTP account portal was removed) |
| `PARKING_GENERAL_RATE_LIMIT_MAX`, `PARKING_PUBLIC_BOOKING_RATE_LIMIT_MAX`, `PARKING_PUBLIC_LOOKUP_RATE_LIMIT_MAX`, `PARKING_PUBLIC_AVAILABILITY_RATE_LIMIT_MAX`, `PARKING_PUBLIC_QUOTE_RATE_LIMIT_MAX` | Rate limits per 15 minutes |
| `PARKING_PUBLIC_BOOKING_MINIMUM_LEAD_MINUTES`, `PARKING_PUBLIC_BOOKING_MAXIMUM_HORIZON_DAYS`, `PARKING_PUBLIC_BOOKING_MINIMUM_WEEKLY_DAYS`, `PARKING_PUBLIC_BOOKING_MAXIMUM_WEEKLY_DAYS`, `PARKING_PUBLIC_BOOKING_MINIMUM_MONTHLY_DAYS`, `PARKING_PUBLIC_BOOKING_MAXIMUM_DAILY_DAYS`, `PARKING_PUBLIC_BOOKING_MAXIMUM_MONTHLY_DAYS`, `PARKING_PUBLIC_QUOTE_TTL_SECONDS` | Booking policy |
| `PARKING_PENDING_BOOKING_EXPIRY_MINUTES`, `PARKING_PENDING_EXPIRY_INTERVAL_MS`, `PARKING_SHUTDOWN_TIMEOUT_MS` | Sweep timing and shutdown |
| `PARKING_PAYMENT_MODE` | `PAY_ON_SITE` (default) or `STRIPE` |
| `PARKING_STRIPE_SECRET_KEY`, `PARKING_STRIPE_WEBHOOK_SECRET`, `PARKING_STRIPE_BILLING_PORTAL_CONFIGURATION_ID`, `PARKING_STRIPE_API_VERSION`, `PARKING_STRIPE_CURRENCY`, `PARKING_STRIPE_CHECKOUT_TTL_SECONDS`, `PARKING_STRIPE_WEBHOOK_GRACE_SECONDS`, `PARKING_MONTHLY_PAYMENT_GRACE_DAYS` | Stripe mode only |
| `PARKING_DEMO_PAYMENT_BYPASS_ENABLED`, `PARKING_DEMO_PAYMENT_BYPASS_TTL_SECONDS` | Demo bypass (off) |
| `PARKING_DOCUMENT_STORAGE_PROVIDER` (`LOCAL` or S3), `PARKING_DOCUMENT_STORAGE_DIR`, `PARKING_DOCUMENT_STORAGE_PUBLIC_URL`, `PARKING_DOCUMENT_STORAGE_SECRET`, `PARKING_DOCUMENT_STORAGE_BUCKET`, `PARKING_DOCUMENT_STORAGE_REGION`, `PARKING_DOCUMENT_STORAGE_ENDPOINT`, `PARKING_DOCUMENT_STORAGE_FORCE_PATH_STYLE`, `PARKING_DOCUMENT_UPLOAD_TTL_SECONDS`, `PARKING_DOCUMENT_READ_TTL_SECONDS`, `PARKING_DOCUMENT_MAX_BYTES` | Driver-licence / insurance uploads. LOCAL default folder: `backend/private-documents` (module-relative) |
| `PARKING_NOTIFICATION_EMAIL_PROVIDER`, `PARKING_NOTIFICATION_EMAIL_FROM`, `PARKING_RESEND_API_KEY`, `PARKING_NOTIFICATION_SMS_PROVIDER`, `PARKING_TWILIO_ACCOUNT_SID`, `PARKING_TWILIO_AUTH_TOKEN`, `PARKING_TWILIO_FROM_NUMBER` | Outbound email/SMS (blank = not sent) |
| `PARKING_TEST_DATABASE` | Must be `parkingops_test` for the integration tests |
| `PARKING_ALLOW_PRODUCTION_SEED`, `PARKING_CANONICAL_LAYOUT_MAINTENANCE` | Guards for the seed and real-lot import scripts |

## Global middleware this app registers (on its own instance)

Order, as mounted in `app.js`:

1. `app.disable('x-powered-by')`; `app.set('trust proxy', PARKING_TRUST_PROXY_HOPS)` when > 0 — both scoped to this app.
2. `helmet({ crossOriginResourcePolicy: { policy: 'same-site' } })`.
3. `cors` — allow-list from `PARKING_CORS_ALLOWED_ORIGINS`, `credentials: true`, methods GET/POST/PATCH/DELETE, headers `Content-Type`, `Idempotency-Key`, `X-CSRF-Token`. Unknown origins get a 403 `CORS_ORIGIN_DENIED`.
4. `express-rate-limit` — `PARKING_GENERAL_RATE_LIMIT_MAX` per 15 minutes, keyed by IP (in-memory store, per process). Route-level limits exist on sign-in, booking, lookup, availability and quotes.
5. `Cache-Control: private, no-store` on `/api/customer/parking/v1/*` and `/api/admin/*`.
6. `POST /api/payments/stripe/webhook` with `express.raw` (must stay ahead of the JSON parser).
7. `express.json({ limit: PARKING_JSON_BODY_LIMIT })` and a tiny cookie parser (`req.cookies`).
8. Routes, then a 404 handler and a JSON error handler (both only for requests that reach this app).

Sessions are database-backed cookies (`parking_admin_sessions`, `parking_customer_lookup_grants`);
there is no `express-session` and nothing is stored on `app.locals`.

## Routes (unchanged paths; hostname routing in the parent)

- `GET /health` → `{ ok: true, module: 'parking' }` (no database)
- `GET /ready` → schema and dependency readiness (503 when the database is unreachable)
- `/api/public/parking/v1/*`, `/api/customer/parking/v1/lookup/*`, `/api/admin/auth/*`, `/api/admin/parking/v1/*`
- `/api/private-documents/*` only when `PARKING_DOCUMENT_STORAGE_PROVIDER=LOCAL`
- `/api/payments/stripe/webhook` (Stripe mode)

## Paths

Everything is resolved from `__dirname`: migrations (`migrations/`), the local document
folder (`private-documents/`), `.env`. Nothing uses `process.cwd()`.

## Process-level behaviour

No `process.on('uncaughtException')`, no `process.exit` outside `server.js` and the CLI
scripts, no prototype changes, no module-level timers. The pool is created when `db.js`
is required (lazy: no socket until the first query).

## Dependencies (exact versions in `package-lock.json`)

express 5.2.1 · pg 8.22.0 · helmet 8.3.0 · cors 2.8.6 · express-rate-limit 8.6.0 ·
bcrypt 6.0.0 · luxon 3.7.2 · dotenv 17.4.2 · stripe 22.5.0 ·
@aws-sdk/client-s3 3.1106.0 · @aws-sdk/s3-request-presigner 3.1106.0.
No `jsonwebtoken`: sessions are opaque random tokens hashed in PostgreSQL.
