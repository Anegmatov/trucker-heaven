# DriveOps Admin Frontend

Internal Nashville office dashboard for fleet management, photo uploads, reservation workflow, and API settings.

Default backend API:

```text
http://localhost:3000
```

Sign in with an owner, manager, or staff account created by `npm run admin:create` in `backend/`. The browser stores no admin credential or session token; the API supplies an HttpOnly session cookie after login.

## Phase 7A reservation actions

The reservation queue displays only server-allowed next actions. OWNER and STAFF can confirm, decline, cancel, mark ready for pickup, check out, mark returned, complete, and mark no-show as allowed by the current state. Each action sends the displayed status version; a `409` reloads current data and does not retry. The expandable timeline is an operational transition summary, not a customer-facing history.

This dashboard does not provide identity verification, agreements, signatures, inspections, damage handling, uploads for inspections, payments, deposits, or fees.

## Run

Terminal 1:

```bash
cd backend
npm run dev
```

Terminal 3:

```bash
cd frontend-admin
python3 -m http.server 5175
```

Open:

```text
http://localhost:5175
```

This app uses cookie-authenticated admin routes and sends its in-memory CSRF token only for state-changing requests:

```text
GET    /api/admin/vehicles
POST   /api/admin/vehicles
PATCH  /api/admin/vehicles/:vehicleId
DELETE /api/admin/vehicles/:vehicleId
POST   /api/admin/vehicles/:vehicleId/photos
GET    /api/reservations
POST   /api/admin/auth/login
POST   /api/admin/auth/logout
GET    /api/admin/auth/session
```

Vehicle status is operational only: `READY`, `MAINTENANCE`, `OUT_OF_SERVICE`, or `RETIRED`. Future bookings are represented by reservation records and dates, never by changing a vehicle to a global “reserved” state.

## Phase 7C inspections

At `READY_FOR_PICKUP`, OWNER and STAFF complete immutable pickup evidence before Check Out is enabled. At `RETURNED_PENDING_INSPECTION`, they complete immutable return evidence before Complete is enabled. No photos, uploads, fees, insurance, payments, or agreements are included.

## Phase 7D notifications and employee accounts

Reservation rows show only safe durable notification history: event, delivery state, attempts, and timestamps. `SENT` appears only after provider acceptance; a local system without a provider shows `SKIPPED`, not a false sent message. Phone numbers, SMS bodies, provider payloads, and credentials are never shown.

All authenticated employees can read the employee directory. Only an OWNER sees account-mutation controls: role change, disable/enable, and revoke sessions. Controls disable while a request is pending, refresh on a stale conflict, and never retry mutations automatically. Password creation/reset and user deletion are intentionally absent; use the protected backend CLI commands. The server prevents self-management in this screen and protects the final active OWNER.

`config.js` defaults to `http://localhost:3000` locally and `https://rentals-api.truckerheaven.com` on a hosted origin. Set a non-secret `window.DriveOpsAdminRuntimeConfig` before it loads to override the API URL; malformed values safely use the default. The app continues to send credentialed requests and relies on the API's explicit CORS allowlist, HTTPS cookie settings, and CSRF protection.
