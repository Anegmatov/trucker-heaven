# FoodOps Production Release Checklist

Updated: 2026-08-25 (America/Chicago)

This document contains no credentials or secret values. A release is allowed only when every hard gate below is checked and independently evidenced.

## Recorded baseline

- Repository host: GitHub (`Anegmatov/trucker-heaven-food`)
- Release branch: `main`
- Baseline commit: `b4d14a7a60d4a106fba545461a9bed3c63ad17d4`
- Baseline worktree: dirty; the application and migrations 005–010 include uncommitted work
- Runtime: Node.js 24.12.0, npm 11.6.2, PostgreSQL 16.15
- Local development database: `foodops_dev_visual`; migrations 001–010 applied with recorded checksums
- Intended hosting target found in repository documentation: Render
- Existing documented Render API and public services: suspended at audit time (HTTP 503)

## Environment variable names

Required production configuration:

- `NODE_ENV`
- `PORT`
- `DATABASE_URL`
- `DATABASE_SSL`
- `DATABASE_POOL_MAX`
- `PUBLIC_ORIGINS`
- `ADMIN_ORIGINS`
- `COOKIE_SECURE`
- `COOKIE_SAME_SITE`
- `SESSION_TTL_HOURS`
- `LOGIN_LOCK_MINUTES`
- `LOGIN_MAX_FAILURES`
- `TRUST_PROXY`
- `FOODOPS_UPLOAD_ROOT`
- `LOG_LEVEL`

Optional Google Places integration:

- `GOOGLE_PLACES_API_KEY`
- `GOOGLE_PLACE_ID`

FoodOps uses opaque 256-bit random session tokens whose hashes are stored in PostgreSQL; it does not use signed cookie payloads and therefore has no application-wide `SESSION_SECRET` value.

## Security and integrity evidence

- [x] `.env` files ignored; only `.env.example` tracked
- [x] Runtime upload contents ignored
- [x] No private keys or production tokens detected in tracked source
- [x] Backend and customer lockfiles present
- [x] `npm ci` succeeds for backend and customer frontend
- [x] Backend and customer dependency audits report zero known vulnerabilities after compatible lockfile updates
- [x] Production startup requires secure cookies
- [x] Production startup requires PostgreSQL SSL
- [x] Production startup requires exact HTTPS public/admin origins
- [x] Production startup requires an explicit upload root
- [x] Admin mutations require an authenticated session and CSRF token
- [x] Unknown CORS origins rejected; wildcard credentials are not used
- [x] Helmet security headers enabled and Express signature disabled
- [x] Upload MIME, extension, size, signature, randomized filename, and confined-path controls present
- [x] Customer order lookup requires normalized exact name and phone, recent 24-hour scope, generic failures, scoped access tokens, and rate limiting
- [x] Public lookup excludes internal notes, staff data, audit rows, database IDs, and internal FoodOps references
- [x] SQL inputs are parameterized; dynamic query fragments are application-generated placeholders/allowlisted clauses
- [x] Clean database migrations 001–010 and full PostgreSQL integration suite pass
- [x] Migration rerun/checksum/advisory-lock behavior passes
- [x] Representative 009→010 upgrade preserves orders, history, menu, inventory-era data, image paths, catering, and users
- [x] Disposable backup/restore test succeeds with PostgreSQL 16 tools
- [x] Authoritative pricing, immutable snapshots, workflow constraints, Pay on Site, and audit records pass
- [x] Concurrent final-unit ordering permits exactly one order and cancellation restoration is idempotent
- [x] Customer production build and frontend contracts pass
- [x] Full backend suite passes: 41/41, including 22/22 PostgreSQL integration subtests with no skips
- [x] Local public browser regression passes: 80/80 route/viewport checks (1920, 1600, 1440, 1280, 1024, 768, 430, 390)
- [x] Local admin browser regression passes: 48/48 page/viewport checks at the same widths
- [x] Local Pay on Site order passes from customer submission through lookup and Kitchen Board completion
- [x] Local uploaded image survives a backend restart when `FOODOPS_UPLOAD_ROOT` points to a persistent directory
- [x] Runtime backend startup does not apply migrations; migrations are an explicit pre-traffic release step

## Hard deployment gates

- [ ] Release work committed and worktree clean
- [ ] GitHub CI run green for the exact release commit
- [ ] Render backend/public services active and production environment reviewed
- [ ] Production PostgreSQL is not a development/test database
- [ ] Production database backup/snapshot completed before migration
- [ ] `FOODOPS_UPLOAD_ROOT` verified as a mounted Render persistent disk, or object storage implemented
- [ ] Disposable image survives a backend restart/redeploy and remains publicly accessible
- [ ] Production migrations 001–010 and readiness endpoint pass
- [ ] Public, admin, database, media, and responsive production smoke tests pass
- [ ] Branch protection requires the FoodOps CI check on `main`

Current deployment decision: **BLOCKED** until every unchecked hard gate is satisfied.

Local restart persistence has been demonstrated, but the production persistence gate remains unchecked because no mounted Render disk or object-storage configuration could be verified. The existing documented Render API and public services return HTTP 503 `Service Suspended`, and no deployed admin service was identified.

## Production backup and restore procedure

1. Put ordering into a controlled maintenance window and record the exact release SHA.
2. Take a provider snapshot when available.
3. Create an encrypted custom-format backup with PostgreSQL 16 `pg_dump --format=custom --no-owner` using the production `DATABASE_URL` from the secret manager.
4. Store the backup outside the application service and record its timestamp and checksum in the private operations log.
5. Restore into an isolated disposable PostgreSQL database with `pg_restore --no-owner`.
6. Verify all ten migration rows and compare counts for users, menu items/images, orders/items/history/notes, inventory fields, catering requests, and audit events.
7. Only after the restore test passes, run production migrations and verify `/readiness`.
8. Roll back by taking the application out of service, restoring the provider snapshot or verified dump, and deploying the previously recorded application SHA.
