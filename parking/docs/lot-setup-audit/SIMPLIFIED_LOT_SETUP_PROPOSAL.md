# Simplified Lot Setup Proposal

## Recommended owner journey

### 1. Lot basics

Ask for lot name, address, timezone, entrance instructions, support contact, and a simple booking choice (customer requests a spot / staff assigns). Put approval mode, buffers, self-service and road URL under **Advanced lot rules**.

### 2. Build the physical map

Open a map-first canvas. Let the owner start blank or place an image as a non-published, opacity-adjustable reference underlay. Add building, office, entrance, exit, lane, arrow, island/turnaround, restricted area and label tools. Support pan/zoom, snap/grid, tablet touch controls, print preview, and lock completed sections.

The primary action is **Add parking row**: place a start/end line or bounding rectangle; choose vertical/horizontal/rotated orientation; number start/end or a supplied sequence; reverse direction; select deliberate skips; preview labels; and create the linked spaces and visual elements in one transaction. Support central irregular rows by editing a row path/individual positions after creation. Support copy row, rotate row, evenly space, and multi-select.

### 3. Set parking use on selected spaces

Use plain chips and presets: Daily, Weekly, Monthly, Bobtail, Tractor + Trailer, Tractor Only, Trailer Only, Company Only, Shop Controlled, Blocked, and Not Bookable. A selected group may have multiple commercial durations but one or more compatible vehicle types. Show a compact summary such as “Spaces 101–124 · Monthly · Bobtail · Staff only.”

Behind the scene, a provisioning service maps the selection to a deterministic internal area, category, inventory, rate rule, visibility and/or block. A label group is visual only unless it also carries a distinct booking/routing policy.

### 4. Rates and rules

Present rates against the selected parking-use group: daily, weekly, monthly, special rate; “customers can book this” or staff-only; and optional vehicle restriction. Default category eligibility from the selected preset. Show advanced timed/priority/location overrides separately.

### 5. Review and publish

Show map and a concise review: duplicate labels, missing/intentional skipped labels, spaces without a use, no eligible booking relationship, no price for bookable use, hidden/staff-only spaces, route/entrance completeness, and affected existing reservations. Let the owner preview the customer pass, confirm the physical map, then publish atomically.

## Primary-map interaction requirements

| Manager need | Proposed control |
|---|---|
| Long/vertical/horizontal rows | Row tool with orientation, dimensions, reverse numbering and bulk generation |
| Irregular central rows | Row editing/path or convert selected spaces to individually positioned items |
| Bobtail/special spaces | Parking-use presets applied to a selection; optional distinct shape/label |
| Skipped numbers | Explicit sequence editor or skip list; no silent auto-fill |
| Buildings, lanes, arrows, islands | First-class primitives; arrows convey travel; islands support polygon/rounded visual-only geometry |
| DAILY/MONTHLY/COMPANY/SHOP labels | Visual grouping labels, independent of whether a new internal area is needed |
| Multi-select/group edits | Marquee/select-by-row/filter; apply use, eligibility, visibility, rate, lock |
| Copy/rotate/space | Group transforms, duplicate row, distribute spacing, snap |
| Mobile/tablet | Responsive editing with touch selection; do not make compact view read-only |
| Printable map | Print stylesheet/export of published layout, legend, date/version, optional staff-only layer |

## Provisioning rules

- Use an existing compatible area/category/inventory when safe; otherwise create a new active relationship with auditable provenance.
- Default to one hidden/default internal area for homogeneous simple lots. Create a distinct area only if the user declares a booking/route/pricing/operating boundary.
- Never reassign or delete inventory, area, space or category records with bookings, assignments, rate/closure history, or layout history. Create replacement records and preserve labels/history.
- Do not infer a physical map from labels alone. Require owner review whenever generating or modifying rows.

## Backend remains rigorous

The simpler UI is a translation layer, not a replacement for protections. It calls a transactional setup command that validates location consistency and versions, provisions records, creates bulk spaces with their linked layout elements, invalidates exact publication, records audit metadata, and returns a reviewable draft. Existing serializable booking transactions, exact assignment exclusion constraints, active/block eligibility, authorization, immutable histories, and draft/publish rules remain unchanged.
