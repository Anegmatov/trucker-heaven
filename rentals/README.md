# DriveOps MVP - Nashville Car Rental System

This package is a cleaned MVP rebuild from the uploaded prototype. The original frontend was static/malformed and the original backend only had a few class-project routes, so this version keeps the DriveOps idea but adds a professional foundation for:

- Admin fleet management
- Admin add/edit car
- Vehicle image uploads
- Public customer car catalog
- Simple reservation creation
- Nashville-only office flow

## Folder structure

```text
DriveOps-MVP/
  backend/            Express + PostgreSQL API
  frontend-customer/  Public rental website
  frontend-admin/     Internal Nashville office dashboard
```

## What was added

### Backend

New core endpoints:

```text
GET    /api/health
GET    /api/health/live
GET    /api/health/ready
GET    /api/public/vehicles
GET    /api/admin/vehicles
POST   /api/admin/vehicles
PATCH  /api/admin/vehicles/:vehicleId
PATCH  /api/admin/vehicles/:vehicleId/status
DELETE /api/admin/vehicles/:vehicleId
POST   /api/admin/vehicles/:vehicleId/photos
PATCH  /api/admin/vehicles/:vehicleId/photos/:photoId/primary
DELETE /api/admin/vehicles/:vehicleId/photos/:photoId
GET    /api/reservations
POST   /api/reservations
PATCH  /api/reservations/:reservationId/status
```

### Database

New MVP tables:

```text
Vehicles
VehiclePhotos
ReservationsMVP
```

The old class-project routes (`/api/auth`, `/api/cars`, `/api/rentals`, `/api/payments`) and their tables were removed; migration `013` drops them.

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Update `.env` with your PostgreSQL credentials. `DATABASE_URL` is preferred for hosted PostgreSQL;
for local development use the `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` variables.

Run the tracked migrations:

```bash
cd backend
npm run migrate
```

Do not run migrations during normal API startup. In production, use `npm run migrate` as a release/pre-deploy command before `npm start`.

Start the API:

```bash
npm run dev
```

API should run at:

```text
http://localhost:3000
```

### 2. Customer Frontend

```bash
cd frontend-customer
python3 -m http.server 5174
```

Open:

```text
http://localhost:5174
```

### 3. Admin Frontend

```bash
cd frontend-admin
python3 -m http.server 5175
```

Open:

```text
http://localhost:5175
```

The parent static site normally runs at `http://localhost:5176`; DriveOps customer and admin run at `http://localhost:5174` and `http://localhost:5175`, with the API at `http://localhost:3000`. Customer `config.js` and admin `config.js` own their non-secret runtime URLs. Their production defaults are `https://truckerheaven.com`, `https://rentals.truckerheaven.com`, `https://rentals-admin.truckerheaven.com`, and `https://rentals-api.truckerheaven.com` as applicable. Configure production CORS with exactly the customer and admin origins, serve all three DriveOps domains over HTTPS, and do not put secrets in frontend configuration.

## Important security note

Do not commit real `.env` credentials. The uploaded backend zip had a `.env` file, so rotate those credentials before publishing the project to GitHub or sharing it with anyone.

The admin dashboard uses HttpOnly server-side sessions with role checks and CSRF protection. Configure its cookie and session settings in `backend/.env` before deployment.

## Phase 7A rental lifecycle

Reservations use one server-authoritative lifecycle: `PENDING_REQUEST → CONFIRMED → READY_FOR_PICKUP → CHECKED_OUT → RETURNED_PENDING_INSPECTION → COMPLETED`. Alternatives are `PENDING_REQUEST → DECLINED` or `CANCELLED`, `CONFIRMED → CANCELLED` or `NO_SHOW`, and `READY_FOR_PICKUP → CANCELLED` or `NO_SHOW`; terminal states have no outgoing actions.

`CONFIRMED`, `READY_FOR_PICKUP`, `CHECKED_OUT`, and `RETURNED_PENDING_INSPECTION` block overlapping half-open `[pickupAt, returnAt)` reservations. Migration `006_rental_operations_lifecycle.sql` adds optimistic `statusversion`, append-only transition history, and the expanded PostgreSQL exclusion constraint. Owner and Manager roles use named, CSRF-protected lifecycle operations; Staff is read-only. A stale version returns `409 RESERVATION_STATE_CONFLICT` and clients reload current data without retrying the mutation.

After review, adopt locally with `npm run migrate` from `backend/`; test migrations only against an explicitly disposable PostgreSQL 16 database. Transition history begins with Phase 7A adoption—no historical actors or timestamps are fabricated. Phase 7A does not implement identity checks, agreements, inspections, signatures, payments, deposits, fees, or real-customer checkout readiness.

## Phase 7C inspections

Pickup and return inspections are internal, immutable operational evidence. Pickup inspection is required before checkout; return inspection is required before completion. This phase adds no inspection photos, uploads, charges, payments, deposits, insurance, license verification, signatures, or agreements.

## Phase 7D durable notifications and employee controls

Migration `008_durable_notifications_admin_controls.sql` replaces best-effort reservation SMS calls with a durable SMS-only outbox. Reservation creation, confirmation, and decline enqueue the already-supported notification event in the same transaction as the business change; a separate `npm run notifications:worker` process claims and sends rows after commit. Attempts are append-only, leases prevent concurrent workers from claiming the same row, and bounded backoff ends in `DEAD_LETTER`. When no SMS provider is configured, the worker records one `SKIPPED` attempt with `PROVIDER_NOT_CONFIGURED`; it never claims that a customer received a message.

The admin dashboard exposes safe notification state only—event type, state, count, and timestamps—never message contents, phone numbers, raw provider payloads, or credentials. OWNER-only mutations let an owner change roles, disable/enable another account, or revoke that employee's sessions. The final active OWNER cannot be disabled or demoted, and an OWNER cannot manage their own account through these controls. Account creation and password reset remain the protected `admin:create` and `admin:reset-password` CLI commands. This phase adds no email, object storage, uploads, payments, deposits, agreement, insurance, or production deployment.
