# Trucker Heaven Parking Operations MVP

Independent customer booking and staff operations application for truck parking. It does not share a database or authentication cookie with DriveOps.

The repository contains two browser applications:

- `frontend-customer`: authoritative customer search, quote, booking, confirmation, pass, map, lookup, and cancellation flow.
- `frontend-admin`: the privacy-gated operations workspace for employees, with OWNER-only Lot Setup, pricing, business settings, closures, and user/security administration integrated into the same shell.

## Local setup

Requires Node.js 20+, PostgreSQL 16, and two static web servers (or any web server capable of serving the frontend folders).

```bash
cd backend
cp .env.example .env
createdb parkingops
npm install
npm run migrate
npm run seed
npm run admin:create -- --username owner --role OWNER --output-file /secure/path/parking-owner-credentials.txt
npm start            # server.js: init() (connect + migrate) then listen on PORT
```

Serve each static application from its own directory:

```bash
npx serve -l 5180 ../frontend-customer
npx serve -l 5181 ../frontend-admin
```

The parent website remains independent. From `/mnt/d/hp/Documents/trucker-heaven-v3/trucker-heaven-frontend-v3`, use its existing local start command; its parking links resolve to `http://localhost:5180` on localhost and `https://trucker-heaven-parking-a437.onrender.com` in production.

URLs: customer `http://localhost:5180`, canonical admin `http://localhost:5181`, API `http://localhost:3001`, health `http://localhost:3001/health`, readiness `http://localhost:3001/ready`.

The admin frontend receives its API, customer, and parent-site URLs from the Render build environment (with an exact-host local/runtime map as the checked-in fallback), validates them in `config.js`, and centralizes authenticated requests in `api.js`. Parking spaces, reservations, dashboard totals, customers, calendar events, activity, reports, and users load only after a valid backend session and remain in memory. OWNER-only advanced configuration uses that same session, API adapter, and CSRF lifecycle. The non-parking legacy panels remain visually present as explicit “Not connected” states; their writes and browser persistence are disabled.

The `seed` command loads explicitly non-production sample capacity and rates. It is never a substitute for configuring a live parking lot.

## Customer booking, payment, and verification

- Daily is an area-capacity product. A paid Daily reservation guarantees capacity in the highlighted compatible parking area and never creates a numbered-space assignment.
- Monthly is a customer-selected numbered-space product. The customer chooses one eligible published space, and the database protects it with an explicit short-lived hold. Once Checkout starts, the local hold is extended through the Stripe Session expiry plus a bounded webhook-delivery grace period. ParkingOps never silently substitutes another space.
- A booking attempt is `DRAFT`/`CHECKOUT_PENDING` until a verified Stripe event succeeds. Daily uses a one-time Checkout Session; Monthly uses a subscription Checkout Session. Amount, currency, product, quote, hold, and selected space are all derived and revalidated server-side.
- The browser return URL never confirms payment. Only the signature-verified endpoint `POST /api/payments/stripe/webhook` can move payment to `PAID` and confirm parking. Processed Stripe event IDs are stored for idempotency and out-of-order events are reconciled by internal metadata, Checkout Session, or subscription ID.
- Recurring failures move Monthly billing to `PAST_DUE` or `PAYMENT_ACTION_REQUIRED` and preserve the assigned space during the configured grace/paid-through period. A subscription ending releases the space only after that protection expires. Customers manage payment methods and invoices through a server-created Stripe Customer Portal session; its configured Portal profile must disable subscription cancellation. Monthly cancellation is initiated inside My Parking, scheduled at the paid-period boundary, and remains subject to ParkingOps space-release rules.
- Monthly customers upload Proof of Vehicle / Carrier Insurance before Checkout. The API stores only document metadata and a randomized private object key. Upload and Admin read access use short-lived signed URLs; completion verifies size plus PDF/JPEG/PNG file signatures. PostgreSQL never stores document bytes or a permanent/public object URL.

### Automatic My Parking accounts

Validated booking contact details create or reuse a canonical customer identity without a registration/password screen. Phone numbers normalize to E.164 and emails normalize for case-insensitive comparison. A paid Stripe event activates the customer, links the Stripe Customer ID, records a customer-facing payment, and saves a reusable vehicle profile while preserving the immutable vehicle details on each reservation. A phone-on-one-account/email-on-another conflict is recorded and never auto-merged. Historical reservations are not guessed into accounts; a signed-in customer must provide the original reservation lookup credential and match a verified contact.

My Parking accepts either phone or email, sends a cryptographically generated six-digit code through the configured provider, stores only a keyed hash, expires it after ten minutes by default, limits attempts and requests, and consumes it once. Customer sessions use a separate HTTP-only cookie and CSRF secret from admin authentication, with absolute and idle expiration. Every reservation, payment, vehicle, document, receipt, billing, and cancellation query enforces the authenticated customer ID on the server. Owner recovery changes require an explicit verified-ownership assertion and support reference, are audited, revoke every customer session, and refuse identifier collisions.

For production email sign-in, configure `NOTIFICATION_EMAIL_PROVIDER=RESEND`, `NOTIFICATION_EMAIL_FROM`, and `RESEND_API_KEY`. For SMS, configure `NOTIFICATION_SMS_PROVIDER=TWILIO`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`. Leaving a channel unconfigured disables that login channel; the server never reports fictitious delivery. The in-memory transport is test-only.

### Stripe test-mode setup

Set `PARKING_STRIPE_SECRET_KEY`, `PARKING_STRIPE_WEBHOOK_SECRET`, `PARKING_CUSTOMER_APP_URL`, and optionally `STRIPE_CURRENCY=usd` on the backend. Set `PARKING_STRIPE_BILLING_PORTAL_CONFIGURATION_ID` only to an operator-reviewed Portal configuration with subscription cancellation disabled; billing management fails closed without it. The service starts without Stripe credentials, but charge-creating endpoints fail closed with a controlled not-configured error. `PARKING_STRIPE_API_VERSION` pins the SDK contract; `STRIPE_CHECKOUT_TTL_SECONDS` and `STRIPE_WEBHOOK_GRACE_SECONDS` keep Stripe's hosted payment window aligned with the local quote/space hold. For local test-mode forwarding, point Stripe CLI at:

```bash
stripe listen --forward-to http://localhost:3001/api/payments/stripe/webhook
```

Copy the resulting `whsec_...` value to `PARKING_STRIPE_WEBHOOK_SECRET`. At minimum subscribe the production webhook to Checkout completion/expiry/asynchronous failure, invoice paid/payment-failed/payment-action-required, and customer subscription updated/deleted events. Never expose either Stripe secret in frontend config, logs, query strings, or metadata.

### Private document storage

Configure a private S3 or S3-compatible bucket with `DOCUMENT_STORAGE_PROVIDER=S3`, `DOCUMENT_STORAGE_BUCKET`, `DOCUMENT_STORAGE_REGION`, and workload credentials supplied through the provider's standard AWS credential chain. Use `DOCUMENT_STORAGE_ENDPOINT` and `DOCUMENT_STORAGE_FORCE_PATH_STYLE=true` only when required by the compatible provider. Block public access at the bucket/account level and allow the backend identity only `PutObject`, `GetObject`, and `HeadObject` for its document prefix. `DOCUMENT_UPLOAD_TTL_SECONDS`, `DOCUMENT_READ_TTL_SECONDS`, and `DOCUMENT_MAX_BYTES` bound signed access and file size.

## Operational behavior

- Public inventory is derived from the one immutable published real-lot layout. Only active, customer-purpose, public, category-compatible, product-eligible spaces with effective server-side pricing contribute to Daily area capacity or Monthly selection.
- Booking intervals are half-open (`[arrival, departure)`), and creation runs in a serializable transaction with per-inventory PostgreSQL advisory locks and an in-transaction capacity recheck.
- Price snapshots are integer cents in immutable JSONB rows. Customer products are explicitly Daily or Monthly; legacy Weekly configuration remains non-public. Stripe line items are produced from those server snapshots, never browser amounts.
- Admin transition paths are centrally constrained: `PENDING → CONFIRMED → CHECKED_IN → CHECKED_OUT → COMPLETED`, with the supported cancellation/no-show/expiration paths. Status and price history are append-only at the database layer.
- Public APIs use opaque location identifiers and never expose rate-rule or database IDs. Lookup requires both the human-readable reservation number and a cryptographically generated credential; the credential is bcrypt-hashed and displayed once on confirmation.
- Customer confirmation persistence defaults to session storage and supports an explicit remember-on-this-device choice. It stores only the reservation number and opaque lookup credential, then restores the safe customer view through the secure lookup endpoint.
- Parking locations define their authoritative IANA timezone. Customer forms submit location-local times, which the backend validates (including daylight-saving gaps and ambiguities) before storing UTC instants.
- Payment and reservation state are separate. Unpaid attempts cannot consume confirmed inventory; abandoned attempts expire and release capacity/holds. Admin confirmation is blocked until payment is `PAID` (or the row is an explicit historical `NOT_REQUIRED` record).

## Backend dependencies

Pinned by `backend/package-lock.json`; keep these major versions when merging into the shared app: express 5.2.1, pg 8.22.0, helmet 8.3.0, cors 2.8.6, express-rate-limit 8.6.0, bcrypt 6.0.0, luxon 3.7.2, dotenv 17.4.2, stripe 22.5.0, @aws-sdk/client-s3 and s3-request-presigner 3.1106.0. There is no jsonwebtoken: staff and customer sessions are opaque tokens hashed in PostgreSQL.

## Environment

Every variable the backend reads is prefixed `PARKING_` (see `backend/env.js`; `PORT` is the only exception) so the API can be mounted as one module in a shared Express app — see `backend/MERGE-NOTES.md` for the app/server split, `init()`, `runMigrations()` and the full variable list. Copy `backend/.env.example`; required production values include `PARKING_DATABASE_URL`, `PARKING_CORS_ALLOWED_ORIGINS`, `PARKING_SESSION_TOKEN_PEPPER`, `PARKING_COOKIE_SECURE=true`, `PARKING_CUSTOMER_COOKIE_SECURE=true`, `PARKING_CUSTOMER_COOKIE_SAME_SITE=none` for separate Render hosts, `PARKING_STRIPE_SECRET_KEY`, `PARKING_STRIPE_WEBHOOK_SECRET`, `PARKING_CUSTOMER_APP_URL`, and private document-storage credentials/bucket configuration. The read-only My Parking and Upload Documents identity lookup does not require Resend, Twilio, email OTP, or SMS OTP; notification transports are optional capabilities for other operational notifications. Configure `PARKING_ADMIN_APP_URL`, `PARKING_STRIPE_BILLING_PORTAL_CONFIGURATION_ID`, `PARKING_STRIPE_API_VERSION`, Checkout/webhook timing, customer/admin session TTLs, `PARKING_CUSTOMER_LOOKUP_TTL_SECONDS`, lookup rate limits, `PARKING_MONTHLY_PAYMENT_GRACE_DAYS`, quote/hold TTL, document TTL/size, and other rate-limit settings for the deployment. The lookup grant is hashed with `PARKING_CUSTOMER_LOOKUP_PEPPER` (falls back to the session pepper). The OTP customer-account portal, the spreadsheet customer/occupancy importers and their one-off repair scripts were removed in October 2026.

Do not use `parkingops_test` for development or production. The test suite refuses to run unless both `PARKING_TEST_DATABASE=parkingops_test` and a matching `PARKING_DATABASE_URL` are set. For Render, point both static applications at `https://trucker-heaven-parking-api-vkf9.onrender.com/api`; set `PARKING_CORS_ALLOWED_ORIGINS=https://trucker-heaven-parking-a437.onrender.com,https://trucker-heaven-parking-admin-krfn.onrender.com`, `PARKING_CUSTOMER_APP_URL=https://trucker-heaven-parking-a437.onrender.com`, and `PARKING_ADMIN_APP_URL=https://trucker-heaven-parking-admin-krfn.onrender.com`.

For separate Render hostnames, backend session cookies require `NODE_ENV=production`, `PARKING_COOKIE_SECURE=true`, and `COOKIE_SAME_SITE=none`; every browser API request uses credentials and every frontend origin must remain explicitly allowlisted. If the API and frontends use same-site custom subdomains, retain the stricter `COOKIE_SAME_SITE=lax`. Never combine `SameSite=None` with an insecure cookie or wildcard CORS.

The canonical admin static service is managed by the root `render.yaml` Blueprint. After any header change, synchronize that Blueprint with the existing `trucker-heaven-parking-admin` service; a source commit alone does not update dashboard-managed static-site headers. The deployed document must return `Cache-Control: no-store`, one CSP containing `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and the restricted `Permissions-Policy`. Run `PARKING_ADMIN_DEPLOYED_URL=https://trucker-heaven-parking-admin-krfn.onrender.com npm run verify:headers` from `frontend-admin` after deployment.

If physical spaces were provisioned under the wrong vehicle category, `npm run repair:exact-space-category` defaults to a dry run. It requires `PARKING_REPAIR_LOCATION_ID`, `PARKING_REPAIR_ZONE_ID`, `PARKING_REPAIR_FROM_CATEGORY`, and `PARKING_REPAIR_TO_CATEGORY`; applying it additionally requires `PARKING_REPAIR_APPLY=true` and `PARKING_REPAIR_CONFIRM=RECLASSIFY_UNASSIGNED_EXACT_SPACES`. It refuses to alter any numbered space with exact-space assignment history; create replacement spaces through Lot Setup when history exists.

## Legacy customer-ledger import

The one-time workbook importer and the spreadsheet occupancy reconciliation were removed in October 2026 (last present at commit 2f84a71). Rows they created keep their `LEGACY_EXCEL_IMPORT` provenance in `parking_customer_import_batches`, `parking_customer_legacy_parking_records` and `parking_customer_legacy_anomalies`; the ledger reads them as before.

## Checks

```bash
cd backend
npm run check
npm test
npm run verify
```

The complete Docker-backed verification provisions an isolated PostgreSQL 16 database, runs migrations twice, seeds it, runs all tests, and checks the parent site:

```bash
cd backend
npm run verify:all
```

It only permits the database named `parkingops_test`; the integration suite refuses any other database name.

## Deployment checklist

1. Provision a separate PostgreSQL database, TLS, DNS, and exact CORS origins for `https://trucker-heaven-parking-a437.onrender.com` and `https://trucker-heaven-parking-admin-krfn.onrender.com`.
2. Run migrations; configure the one published real lot, eligible Daily/Monthly spaces, rates, restrictions, closures, tax/fee rules, and cancellation policies.
3. Generate the first owner account to a protected filesystem path; rotate credentials after first use.
4. Set a unique, long `PARKING_SESSION_TOKEN_PEPPER`, secure cookies, backups, log retention, and monitoring for `/ready`.
5. Configure Stripe test/live keys, the signed production webhook, Customer Portal, `PARKING_MONTHLY_PAYMENT_GRACE_DAYS`, and alerting for failed or unprocessed events.
6. Configure a private document bucket and least-privilege workload credentials; verify public access is blocked and signed URLs expire.
7. Confirm cancellation/refund policy, arrival instructions, Daily highlighted-area copy, Monthly selected-space copy, and insurance-review procedure with parking staff.
8. Smoke-test Daily Checkout, Monthly hold/upload/subscription Checkout, webhook confirmation, duplicate events, abandoned Checkout release, Portal access, past-due grace, secure document review, lookup, check-in/out, and parent-site CTA after deployment.
