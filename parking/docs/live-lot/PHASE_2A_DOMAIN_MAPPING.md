# Phase 2A Domain Mapping

| Read-model field | Authoritative source |
|---|---|
| Lot identity/timezone | `parking_locations` |
| Physical space identity/activity/number | `parking_spots` |
| Parking area | `parking_zones` joined through `parking_spots.zone_id` |
| Vehicle eligibility | `parking_inventory.category_id` → `parking_categories` |
| Published map/version/elements | `parking_lot_layouts` where `status='PUBLISHED'`, plus `parking_layout_elements` |
| Current block | unreleased `parking_spot_blocks` interval containing `evaluatedAt` |
| Exact assignment | unreleased `reservation_spot_assignments` |
| Reservation state/customer/vehicle | `parking_bookings` joined from assignment |
| Assignment history | immutable `reservation_spot_assignments` history |
| Notes | bounded internal `parking_booking_notes` for the current reservation |

`backend/services/liveLotReadModel.js` is a read-only projection. It does not create a status source or duplicate reservation logic. The legacy `exactSpaceService.liveLot` remains unchanged for the existing admin view.

The current schema does not contain a durable per-space Daily/Monthly/Company/Shop tag. `parkingUse` is therefore `MONTHLY` only when the current booking interval is at least 28 days; otherwise it is `UNCLASSIFIED`. This deliberately avoids guessing manager classifications.

## Query strategy

Snapshot uses three bounded reads regardless of space count: location, published layout/elements, and all spaces with lateral current-block/current-assignment/next-assignment lookups. Detail reuses the snapshot projection and adds bounded history/notes/current-booking reads. Timeline uses one space lookup plus one bounded assignment query and one bounded block query. Search issues four location-scoped, capped queries. No cache or new index was added: existing spot, assignment-history, block-overlap, booking-availability, and published-layout indexes cover the operational joins, and the expected lot is roughly 185 spaces.
