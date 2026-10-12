# ParkingOps Admin Consolidation Handoff

## Final architecture

ParkingOps now has one shared backend and two browser applications:

- `backend` — shared ParkingOps API and PostgreSQL persistence
- `frontend-customer` — public booking, reservation management, pass, and map flows
- `frontend-admin` — the canonical employee operations workspace

`frontend-operations` was promoted into `frontend-admin` and retired. No database, backend, or customer data architecture changed during consolidation, and no production data or private legacy source was accessed.

## Canonical admin

The default admin experience retains the approved operations design and behavior: Dashboard, Live Lot, Reservations and detail actions, Customers, Calendar, Activity, Parking Reports, authentication, backend error handling, session expiry, logout, and the safely disabled non-parking modules. Private responses remain memory-only and are cleared on logout, expiry, or failed authoritative refresh.

OWNER accounts additionally see `Advanced Configuration` and `Users`. Advanced Configuration contains the preserved Lot Setup editor, parking-space classification, canonical maintenance lock, structural geometry tools, draft save, customer-safe preview, publish checklist, rate plans, property/contact/hours/instructions, booking policies, and closures. The Users page retains the complete owner security controls, including role, active-state, password, self-protection, and last-owner protections. These modules use the canonical shell's API adapter, cookie session, CSRF token, unauthorized handler, and private-state lifecycle. STAFF accounts do not receive these navigation entries, and backend authorization remains authoritative.

## Deployment and configuration

- Admin: `https://trucker-heaven-parking-admin-krfn.onrender.com`
- Customer: `https://trucker-heaven-parking-a437.onrender.com`
- API: `https://trucker-heaven-parking-api-vkf9.onrender.com/api`

The checked-in Render Blueprint deploys the canonical `frontend-admin` to the existing admin service. It does not define or create a replacement operations service. Normal production CORS is limited to the customer and admin origins; wildcard CORS is prohibited. The existing cookie security, SameSite configuration, CSRF enforcement, and OWNER/STAFF backend permissions are unchanged.

The old `trucker-heaven-parking-operations` Render static service is no longer required by source code or navigation. After the canonical admin deployment is verified, it may be manually suspended or deleted. It was intentionally not removed automatically through a risky Blueprint action.

## Privacy and release safety

The consolidation reuses only the already sanitized operations implementation and the existing repository admin modules. It does not read or copy the private legacy `/mnt/d/hp/Documents/Parking/index.html`. Source and generated artifacts are checked for real email/phone literals, credential markers, private workstation paths, legacy seed markers, browser record persistence, direct database access, and source maps.
