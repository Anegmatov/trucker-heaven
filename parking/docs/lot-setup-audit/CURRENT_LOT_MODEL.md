# Current Lot Model

## Scope and evidence

This audit is based on migrations `001`–`014`, the admin and public routes, services, admin/customer frontends, verification scripts, integration tests, and `README.md`. No application or database changes were made.

The original schema calls the physical subdivision a `parking_zone`; the current owner UI renames it **Parking Area**. This document uses **area (database: zone)** to avoid pretending these are two different data models.

## Actual dependency diagram

```text
Parking location
  ├─ area / parking_zone (optional public opaque ID; directions; visibility)
  │    ├─ inventory = area × vehicle category (capacity, restrictions, visibility)
  │    │    ├─ rate rules (location + optional area + category)
  │    │    ├─ capacity bookings (legacy / zone-capacity mode)
  │    │    └─ numbered parking spaces (exact-space mode)
  │    │         ├─ spot blocks
  │    │         ├─ reservation spot assignments → booking
  │    │         └─ one linked PARKING_SPOT layout element
  │    └─ area directions (entrance, exit, route element keys)
  ├─ draft layout ──publish snapshot──> published layout
  │    └─ layout elements (map geometry; may link to area, inventory, and spot)
  └─ bookings (location + inventory + category; immutable price/status history)
```

`parking_categories` is a shared catalog, not owned by a location. In exact mode, a public booking is first selected by public area ID and category code, then is matched to an eligible space with the same inventory. The database verifies every cross-reference.

## Model relationships and responsibilities

| Concept | Current record(s) | What it means now | Dependents |
|---|---|---|---|
| Location | `parking_locations` | Facility, address, timezone, booking and assignment policy | areas, layouts, bookings, rates, closures, spots |
| Area / zone | `parking_zones` | Operational/public subdivision of a location; directions and public visibility | inventory, rates, closures, spots, layout links, route directions |
| Vehicle category | `parking_categories` | Shared vehicle compatibility catalog (e.g. `BOBTAIL`) | inventory, rates, bookings |
| Inventory | `parking_inventory` | The area/category compatibility and capacity row | bookings, closures, spots, layout links |
| Numbered space | `parking_spots` | A uniquely labelled physical space, attached to one area and inventory | blocks, assignments, linked map element |
| Layout element | `parking_layout_elements` | Draft/published visual object; generic geometry and label | map display, routes; parking elements link to a space |
| Block | `parking_spot_blocks` | Time-bounded operational unavailability with reason/audit actor | exact availability and assignment |
| Reservation | `parking_bookings` | Commercial booking interval and state | price/status history, notes, exact assignment |
| Assignment | `reservation_spot_assignments` | Immutable/history-preserving exact-space allocation | excludes overlapping current allocations |

## Invariants that matter

- One active draft and one published layout are allowed per location. Published layouts are snapshots; draft edits remain private.
- Space labels and visual-element keys are unique within their location. A space must have an area and an inventory whose area/category relationship is valid.
- A linked `PARKING_SPOT` layout element must match its space's location, area, inventory, and visual key. The bulk-space endpoint creates both records together.
- Exact assignments must match the booking's location, inventory, category, and exact interval. PostgreSQL's exclusion constraint prevents overlapping current assignments to one space.
- Booking creation runs at serializable isolation, locks/rechecks availability, supports idempotency, and keeps immutable price/status history.
- A blocked, inactive, unlinked, unpublished, incompatible, or already-assigned space is ineligible for exact booking.
- Editing physical setup invalidates `exact_mode_active`; publication requires checklist completion and owner physical confirmation.

## Important terminology observation

There is no separate `parking_areas` table: “area” is an owner-facing alias for `parking_zones`. Therefore “area versus zone” is primarily a terminology/UI duplication, not two records to reconcile. The general configuration screen still exposes **Zones**, while Lot Setup exposes **Parking Areas**, which makes one object appear to be two concepts.

## Existing implementation touchpoints

- Schema: `backend/migrations/001_parking_ops.sql`, `012_parking_lot_layouts.sql`, `013_exact_space_parking.sql`, `014_public_parking_area_ids.sql`.
- Setup/provisioning: `backend/routes/adminParking.js` (`/setup`, areas, bulk spaces, directions, layout publish).
- Safety/operations: `backend/services/exactSpaceService.js`, `backend/services/bookingWorkflow.js`, `backend/services/parkingService.js`.
- UI: `frontend-admin/app.js`, `frontend-admin/index.html`; customer booking consumes public areas, categories, availability, and published map.
- Verification: `backend/test/lotSetup.integration.test.js`, `layout.integration.test.js`, `exactSpace.integration.test.js`; `backend/scripts/verifyAdminLotSetup.js` and `verifyAdminLayout.js`.
