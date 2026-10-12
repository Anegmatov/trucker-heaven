# Current Owner Workflow

## What an owner does today

The owner-only **Lot Setup** wizard is six steps: Lot Details, Parking Areas, Numbered Spaces, Entrances & Directions, Customer Preview, and Publish. A separate general Configuration screen also exposes locations, zones, categories, inventory, rates, and closures. This duplicates the mental model even though the wizard provisions some records automatically.

| Step | What the owner sees and must understand | Created/changed records and validation | Risks / necessity |
|---|---|---|---|
| 1. Lot details | Name, address, timezone, support phone, road URL, arrival/exit text, approval policy, assignment mode, self-service, check-in and turnaround timing | Creates/updates `parking_locations`; optimistic version check; timezone/db validation; assignment mode must be zone capacity or exact spot | Facility facts and operating policies are necessary. “Assignment mode” and buffers are advanced configuration, not first-time-map concepts. |
| 2. Parking areas | A named area, public/internal descriptions, order, active/public checkboxes, then one or more vehicle types; an action may add canonical categories | Creates/updates `parking_zones`; creates/reactivates an `parking_inventory` row for every selected category; deactivates unselected inventory | Owner must understand area, category, and their many-to-many relationship before seeing the map. At least one category is required for active/public area. This is the most material abstraction leak. |
| 3. Numbered spaces | Selects an area + vehicle type/inventory, number prefix/start/padding, quantity, rows, orientation, direction, geometry, group and notes | Requires a draft layout. Creates every `parking_spots` row and matching `PARKING_SPOT` layout element transactionally; labels must be unique and geometry in 0–100 bounds | Bulk creation is operationally useful, but it is form-first and requires knowing the hidden inventory relationship. Reversed numbering is supported; skipped/non-sequential numbers are not a first-class bulk pattern. |
| 4. Entrances and directions | Must add map elements in the embedded visual editor, then choose an area, entrance and exit elements, written arrival/exit directions | Saves generic `parking_layout_elements`; saves `parking_area_directions`; each element can link to area/inventory. Invalidates exact publication | Map editing is necessary, but owner must manually make route references after earlier form steps. The palette lacks arrow/island/curved-shape primitives and no bulk row manipulation. |
| 5. Customer preview | Selects a sample space and sees its pass, area directions and map | Read-only preview of draft/published elements | Necessary confidence check. It comes too late to drive initial map construction. |
| 6. Publish | Checklist and physical confirmation, then “Publish Exact-Space Lot” | Checks address/timezone/phone/road URL, active area, active categories/inventory, active spaces linked exactly once, directions/routes, readable map and physical confirmation; publishes draft snapshot and activates exact mode | Necessary safety gate. It currently requires more per-area route/direction configuration than a simple one-entrance lot may need. |

## Current validation and failure modes

- Owner role, CSRF, optimistic versions, same-location links, dimensions, valid text/URLs, and numeric bounds are enforced at the routes and database.
- The owner cannot generate spaces until a draft exists, and cannot publish until every active space has one visual link plus entrance/exit/routes for every public area.
- Duplicate labels conflict; deactivating a space with future assignments is refused; areas/inventory with history cannot be reassigned.
- Draft changes invalidate exact-mode publication. The public site continues serving the prior published snapshot until successful publish.
- Capacity/inventory settings also remain editable in the separate configuration page, creating a risk of two places with differently framed controls.

## Repeated entry / overlapping information

1. The owner names an area and selects vehicle types, then selects the resulting area/vehicle inventory again to create spaces.
2. Area, category and inventory appear both in Configuration and Lot Setup; **zone** and **parking area** refer to the same table.
3. An area can be represented as an area record, a `PARKING_ZONE` map element, labels, area directions, and the area link carried by every space.
4. Public visibility exists on area, inventory-related public configuration, layout element, and location policy layers. They are not identical controls, but their UI presentation does not explain their different effects.
5. Capacity exists on inventory while exact availability actually counts eligible numbered spaces. In exact mode, inventory capacity is effectively compatibility metadata, while the map's spaces are the live capacity source.

## Terminology assessment

“Parking area” is understandable when it names a genuinely different arrival/direction/customer selection area. “Zone,” “inventory,” and an abstract “vehicle category” are understandable to a system administrator, not needed for normal lot drawing. “Numbered space,” “parking type,” “customer-facing,” “staff-only,” “blocked,” and “daily/monthly” are closer to the manager's language.

## Features present versus absent in the editor

Present: blank draft, generic canvas, drag/resize, rotation, keyboard move, zoom, label, entrance/exit, office, lane, restricted area, duplicate element, one-at-a-time number-space creation, and bulk grid generation.

Absent or insufficient: image/reference underlay, multi-select, group parking-use assignment, copy/rotate a row as a unit, evenly-space tools, row lock, explicit arrows, curved islands/turnarounds, skipped-number templates, map-first creation, tablet editing (compact view is read-only), and print output.
