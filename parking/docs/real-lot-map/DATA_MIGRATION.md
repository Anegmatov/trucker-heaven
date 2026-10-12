# Data migration

Migration 015 is replay-safe and adds only durable metadata and an index. Existing generic spaces are never renamed. The import deactivates generic active spaces while retaining their records and assignment history; the generated real-numbered spaces become the active map inventory.

## Legacy replacement dependency order

The live legacy baseline is `South Zone` with a published `North Zone layout` v4 and
25 linked generic parking elements (`N-01`–`N-15`, `S-01`–`S-10`). The importer
does not use `CASCADE` and does not truncate any table. It locks the location and,
in one transaction, performs the safe dependency order below:

1. Lock the location and verify the exact recognizable legacy baseline.
2. Create or reactivate the canonical zone/inventory relationships.
3. Rebuild only the writable draft's layout elements, then create/update the 185
   numeric `parking_spots` and their draft map elements.
4. Insert non-space diagram elements, classifications, and public-booking gates.
5. Deactivate the generic spaces and hide their legacy zones from public capacity.
   Generic spot rows stay intact because published historical elements,
   `reservation_spot_assignments`, `parking_spot_blocks`, and booking labels can
   reference them. No reservation, confirmation, payment, user, or audit row is
   deleted or rewritten.
6. Create a new immutable published snapshot and mark the old published snapshot
   `SUPERSEDED`. The historical generic map remains readable but cannot be served
   as the current public layout.

The importer first reports whether any generic spot has assignment, booking-label,
or block history. Therefore the preservation decision is deterministic: retain
inactive generic rows for history, never silently remap an assignment, and never
allow them to count toward public availability.

## Canonical-map maintenance lock

Once a location has a layout named `Trucker Heaven physical lot · …`, normal OWNER
requests cannot create drafts, alter elements, publish replacement geometry,
bulk-create spaces, or rename a physical space. Those endpoints return
`CANONICAL_LAYOUT_LOCKED` unless the backend is deliberately started with
`PARKING_CANONICAL_LAYOUT_MAINTENANCE=true` during an approved maintenance window.
Operational blocks and non-structural use/classification changes remain available.
# Immutable publication migration

Migration 016 adds `SUPERSEDED` layout history. It retains existing published layouts unchanged, adds immutable snapshot enforcement, and does not supersede anything by itself. Production sequence: migrate through 016, perform a guarded dry-run, then use the combined guarded apply/publish command during the approved maintenance operation.

## Legacy fixture contract

For a valid pre-016 parking-space element, `element_key` must exactly equal its linked spot's `visual_element_key`. The PostgreSQL 18 upgrade verifier inserts location, zones, category/inventory, OWNER, published layout, generic spot, matching-key element, booking, and historical assignment in that order. It snapshots those rows, applies 016–019, verifies the snapshot remains unchanged, tests immutability, runs the real-lot importer, and confirms migration replay is a no-op.
