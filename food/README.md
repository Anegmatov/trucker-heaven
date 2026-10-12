# FoodOps MVP

FoodOps is the independent Trucker Heaven Food & Lounge platform. It contains a public customer site, an OWNER/STAFF administration application, and a PostgreSQL-backed Express API. Customers can browse the menu, build a dine-in or takeout order, submit it without online payment, receive a private lookup credential, and follow its status. Restaurant staff can manage content and operate the order lifecycle.

**Payment is collected at pickup or on site.** FoodOps does not collect cards, deliver food, reserve tables, or call a payment provider.

## Applications

| Application | Default URL | Directory |
| --- | --- | --- |
| FoodOps API | `http://localhost:3011` | `backend/` |
| Public Food & Lounge site | `http://localhost:5173` | `frontend-public/` |
| FoodOps administration | `http://localhost:5191` | `frontend-admin/` |

The approved public site is a React/Vite application that uses same-origin `/api/v1/public/...` requests. The operations admin remains a framework-free application configured by `frontend-admin/config.js`.

## Local setup

Requirements: Node.js 20+, npm, and a dedicated PostgreSQL 16 database. Never point this project at `ifta_db` or a ParkingOps/DriveOps database; environment validation rejects `ifta_db` by name.

```bash
cd backend
cp .env.example .env
npm ci
npm run migrate
npm run seed
npm start
```

In another terminal, run the public React application:

```bash
cd frontend-public
npm ci
npm run dev
```

Run the operations admin from the repository root:

```bash
node scripts/serve-frontends.js
```

Development seed accounts default to:

- OWNER: `owner@truckerheaven.test` / `ChangeMe-FoodOps-2026!`
- STAFF: `staff@truckerheaven.test` / `ChangeMe-Staff-2026!`

These are local development credentials only. Override both password variables in `.env`, and never use seed defaults in a shared environment.

## Database and migrations

`backend/migrations/run.js` applies sequential SQL files under an advisory lock and records checksums in `schema_migrations`. Re-running the migration command is safe; changing an already-applied migration is rejected.

- `001_foodops_foundation.sql` creates authentication, menu, content, settings, ordering, note, idempotency, and audit tables.
- `002_order_history_integrity.sql` enforces valid order transitions and makes order-item snapshots and status history append-only.

Menu prices and every order total are integer cents. The server ignores the browser as a pricing authority and creates immutable item snapshots when the order is placed.

## API outline

Public endpoints:

- `GET /health`
- `GET /readiness`
- `GET /api/v1/public/site`
- `GET /api/v1/public/categories`
- `GET /api/v1/public/menu`
- `POST /api/v1/public/orders` with `Idempotency-Key`
- `GET /api/v1/public/orders/:orderNumber` with an `X-Order-Access-Credential` header
- `POST /api/v1/public/orders/:orderNumber/cancel`

Admin endpoints use `/api/v1/admin/...`. Login creates an opaque, hashed server-side session with an HttpOnly cookie. State changes require the per-session `X-CSRF-Token`. Backend role checks—not navigation visibility—protect OWNER-only user management.

## Images

The available approved Trucker Heaven logo, lounge hero, and lounge gallery photograph are copied into this repository. See `docs/ASSET_MAP.md` for exact read-only sources and the required future food-crop filenames. The supplied attachment did not include the approved mockup image or individual food crops; the public and admin applications deliberately render an accessible photo-pending state rather than substitute unrelated photographs.

Admin uploads accept JPG, JPEG, PNG, and WEBP up to 5 MB. File extension, MIME type, and magic bytes must agree. Stored names are random, temporary files remain private, SVG/executable uploads are rejected, and only finalized files are served.

## Verification

Focused checks during development:

```bash
cd backend
npm run check
npm run frontend:check
npm run test:unit
```

PostgreSQL integration checks require a database whose name clearly contains both `foodops` and `test`. The test drops and recreates only that disposable database's `public` schema and cleans temporary uploads:

```bash
TEST_DATABASE_URL=postgresql://.../foodops_test npm run test:integration
```

Run the complete project verification only after focused checks pass:

```bash
node scripts/verify.js
```

The integration suite covers migrations and repeat seed, menu/category management, image acceptance and rejection, idempotent authoritative ordering, immutable snapshots, secure lookup, public/internal note separation, cancellation, OWNER/STAFF authorization, CSRF, full order status transitions, manual on-site payment, audit events, health, readiness, and cleanup.

## Operational notes

- Set `COOKIE_SECURE=true` in production; startup refuses insecure production cookies.
- Configure exact comma-separated frontend origins. Unknown browser origins are denied.
- Runtime uploads need persistent disk or object storage. `FOODOPS_UPLOAD_ROOT` defaults to `backend/uploads` locally and stores finalized menu images in `menu-items/` and private temporary files in `tmp/` beneath the configured root.
- Runtime startup never applies migrations or seeds.
- `/health` proves the process is alive; `/readiness` requires the complete FoodOps schema.
- `SIGINT` and `SIGTERM` stop the HTTP server and close the PostgreSQL pool.
- Request logs contain method, path without query string, status, timing, and request ID—never bodies, cookies, tokens, or credentials.
- No deployment or third-party provider integration is included.

## Production environment

Configure these placeholders in the deployment platform; do not commit a production `.env` file or seed credentials:

```dotenv
NODE_ENV=production
PORT=<platform-provided>
DATABASE_URL=<foodops production database URL>
DATABASE_SSL=true
PUBLIC_ORIGINS=https://trucker-heaven-food.onrender.com
ADMIN_ORIGINS=<exact deployed FoodOps admin origin>
COOKIE_SECURE=true
COOKIE_SAME_SITE=Lax
TRUST_PROXY=true
FOODOPS_UPLOAD_ROOT=<persistent disk mount path>
LOG_LEVEL=info
```

The confirmed Render API is `https://trucker-heaven-food-api.onrender.com`. The public frontend uses `https://trucker-heaven-food-api.onrender.com/api/v1/public` and the admin frontend uses `https://trucker-heaven-food-api.onrender.com/api/v1/admin`. The public Render origin is `https://trucker-heaven-food.onrender.com`; configure `ADMIN_ORIGINS` with the exact deployed admin origin before enabling that frontend.

Public menu records are returned only when their category is active and the menu item is both active and available. Public site, category, and menu responses use a no-store cache policy so an owner update is reflected on the next refresh.
