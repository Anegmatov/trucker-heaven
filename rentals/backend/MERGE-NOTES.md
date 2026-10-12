# Merge notes — rentals backend as a module

This backend is ready to be mounted inside a shared Express process (one Render service, routed by hostname). Nothing here performs that merge; this is what the parent app needs to know.

## What `app.js` exports

```js
const rentalsApp = require("./rentals/backend/app");   // an Express app, fully wired (middleware + routes)
rentalsApp.createApp(options)                           // also exposed: build another instance (tests use it)
```

Requiring `app.js` reads `RENTALS_*` env (via `config/env.js`) to build the config, and nothing else: no database connection, no migrations, no timers. If `NODE_ENV=production` and required settings are missing (`RENTALS_CORS_ALLOWED_ORIGINS`, `RENTALS_SESSION_TOKEN_PEPPER`, `RENTALS_COOKIE_SECURE=true`) the require throws with a clear message.

## What `startup.js` exports and what `init()` does

```js
const { init, runMigrations, shutdown } = require("./rentals/backend/startup");
await init();            // 1) creates the pool from RENTALS_DATABASE_URL  2) SELECT 1  3) runMigrations()
await runMigrations();   // idempotent: applies migrations/*.sql not yet recorded in schema_migrations,
                         // under pg_advisory_lock(712694231); pass a URL to migrate another database
await shutdown();        // closes the pool
```

`init({ migrate: false })` skips migrations. The standalone `server.js` is just `init()` then `listen(PORT)`.

Migration command (standalone): `npm run migrate` (= `node migrations/run.js`, same routine).

## Mounting

Route paths are unchanged (`/api/...`, `/uploads/vehicles/...`, `/health`), so hostname routing is enough:

```js
parent.use(vhost("rentals-api.truckerheaven.com", rentalsApp));   // or any hostname router
```

`trust proxy` is set on this app from `RENTALS_TRUST_PROXY` (default 0). Set it to `1` on Render.

## Every env var read (all prefixed `RENTALS_`)

Unprefixed exceptions: `PORT` (standalone `server.js` only) and `NODE_ENV` (process-wide; `RENTALS_NODE_ENV` overrides it if set).

| Variable | Purpose | Default |
| --- | --- | --- |
| RENTALS_DATABASE_URL | PostgreSQL connection string (preferred) | — |
| RENTALS_PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD | Used only when DATABASE_URL is absent | localhost / 5432 / driveops / — / — |
| RENTALS_PGPOOL_MAX | Pool size | 10 |
| RENTALS_DATABASE_SSL, RENTALS_PGSSLMODE, RENTALS_DATABASE_SSL_REJECT_UNAUTHORIZED | TLS to PostgreSQL | off / — / true |
| RENTALS_CORS_ALLOWED_ORIGINS | Comma-separated browser origins; required in production | localhost:5174,5175 in dev |
| RENTALS_TRUST_PROXY | Express `trust proxy` hops | 0 |
| RENTALS_JSON_BODY_LIMIT | JSON/urlencoded body limit | 1mb |
| RENTALS_PUBLIC_BASE_URL | Absolute base for vehicle photo URLs | request host |
| RENTALS_CUSTOMER_SITE_URL | Customer site origin used in confirmation texts | — |
| RENTALS_SESSION_TOKEN_PEPPER | HMAC pepper for admin sessions and customer access grants; required in production | dev-only value |
| RENTALS_SESSION_COOKIE_NAME, RENTALS_SESSION_TTL_SECONDS, RENTALS_COOKIE_SECURE, RENTALS_COOKIE_SAME_SITE, RENTALS_CSRF_HEADER_NAME | Admin session cookie | driveops_admin_session / 28800 / prod=true / lax / x-csrf-token |
| RENTALS_ADMIN_LOCKOUT_THRESHOLD, RENTALS_ADMIN_LOCKOUT_SECONDS | Admin login lockout | 5 / 900 |
| RENTALS_RATE_LIMIT_WINDOW_MS, RENTALS_RATE_LIMIT_MAX | General `/api` limiter | 15 min / 300 |
| RENTALS_RESERVATION_RATE_LIMIT_WINDOW_MS, RENTALS_RESERVATION_RATE_LIMIT_MAX | Public reservation creation | 60 min / 10 |
| RENTALS_LOOKUP_RATE_LIMIT_WINDOW_MS, RENTALS_LOOKUP_RATE_LIMIT_MAX | Find-my-rental lookups | 15 min / 20 |
| RENTALS_FOOD_ORDER_RATE_LIMIT_WINDOW_MS, RENTALS_FOOD_ORDER_RATE_LIMIT_MAX | Food orders | 60 min / 20 |
| RENTALS_ADMIN_RATE_LIMIT_WINDOW_MS, RENTALS_ADMIN_RATE_LIMIT_MAX | Admin API | 15 min / 120 |
| RENTALS_ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS, RENTALS_ADMIN_LOGIN_RATE_LIMIT_MAX | Admin login | 15 min / 10 |
| RENTALS_MAX_RENTAL_DAYS | Longest reservation | 30 |
| RENTALS_RENTAL_PAYMENT_MODE | PAY_AT_PICKUP (only supported value) | PAY_AT_PICKUP |
| RENTALS_VEHICLE_UPLOAD_DIR | Vehicle photos (public, served at /uploads/vehicles) | `<module>/uploads/vehicles` |
| RENTALS_RENTAL_UPLOAD_DIR, RENTALS_RENTAL_DOCUMENT_MAX_BYTES | Private rental documents | `<module>/uploads/rentals-private` / 6 MB |
| RENTALS_SMS_ENABLED, RENTALS_SMS_TIMEOUT_MS, RENTALS_TWILIO_ACCOUNT_SID, RENTALS_TWILIO_AUTH_TOKEN, RENTALS_TWILIO_MESSAGING_SERVICE_SID, RENTALS_TWILIO_FROM_NUMBER | Text messages | off |
| RENTALS_RENTAL_OFFICE_NAME, RENTALS_RENTAL_OFFICE_ADDRESS, RENTALS_RENTAL_OFFICE_PHONE | Office details in texts | Trucker Heaven values |
| RENTALS_NOTIFICATION_MAX_ATTEMPTS, _INITIAL_DELAY_MS, _MAX_DELAY_MS, _LEASE_MS | Outbox worker (`npm run notifications:worker`, separate process) | 5 / 30 s / 1 h / 60 s |
| RENTALS_ENABLE_LEGACY_ROUTES | Dev-only legacy routes; refused in production | off |
| RENTALS_ADMIN_BOOTSTRAP_EMAIL / _PASSWORD | `npm run admin:create` non-interactive input (script only) | — |
| RENTALS_TEST_DATABASE_URL | Disposable DB for `npm test` integration tests (tests only) | — |

Relative upload directories resolve against this module folder (`path.resolve(__dirname, '..', value)`), never `process.cwd()`. Migrations are read from `<module>/migrations`.

## Global middleware this app registers (on its own instance only)

- `helmet()` with `crossOriginResourcePolicy: cross-origin` (vehicle photos are embedded by the customer site).
- `cors()` with a strict origin allow-list from `RENTALS_CORS_ALLOWED_ORIGINS`, `credentials: true`, methods GET/HEAD/POST/PATCH/DELETE, headers `Content-Type, X-CSRF-Token, X-Reservation-Access-Token, Idempotency-Key`.
- `express.json` / `express.urlencoded` with `RENTALS_JSON_BODY_LIMIT`.
- `express.static` for `/uploads/vehicles` (nosniff).
- express-rate-limit instances: general (`/api`), reservation create, lookups, food, admin, admin login. They keep counters in process memory, per app instance.
- Admin sessions: opaque token in an `HttpOnly` cookie scoped to `/api`, verified against PostgreSQL; CSRF header on mutations. No `express-session`, no JWT.
- A final JSON 404 for `/api/*` and a JSON error handler. The error handler never exits the process.

Not registered: no `process.on('uncaughtException')`, no cron timers. `server.js` installs SIGTERM/SIGINT handlers only when run directly.

## Module-level state to be aware of

- `app.locals.driveOpsConfig` holds this module's config (read via `req.app.locals`, which resolves to this app when mounted).
- `configureReservationRequestPolicy()` and `configureSmsService()` store settings in module scope: fine for one rentals module per process.
- `db/connection.js` is the single pool for the module; it is created on first use (or by `init()`), exported as `db` with `query`, `connect`, `end`, `testConnection`.

## Dependencies (exact installed versions)

express 5.2.1 · pg 8.22.0 · express-rate-limit 8.5.2 · helmet 8.3.0 · cors 2.8.6 · multer 2.2.0 · bcrypt 6.0.0 · dotenv 17.4.2. No new dependencies were added for this work.
