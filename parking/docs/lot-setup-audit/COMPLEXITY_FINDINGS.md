# Complexity Findings

## Classification

| Concept | Classification | Finding and owner-facing recommendation |
|---|---|---|
| Locations | A / F | A facility must be selected or created. Show as “Lot”; keep identifiers/policies internal or advanced. |
| Areas (`parking_zones`) | B, sometimes A/F | Required by current public selection, rates, directions and inventory. Show only when a customer/arrival/direction group genuinely differs; otherwise provision one default internal area. |
| Zones | D | “Zone” and “parking area” are the same database record. Remove “zone” from owner language. |
| Vehicle categories | B / C | Needed for compatibility and booking. Provide parking-type presets; expose per-vehicle overrides only in Advanced Setup. |
| Parking inventory | B / F | Critical area×category join used by bookings, rates, closures and exact-space eligibility. Never ask the ordinary owner to create it directly. |
| Numbered spaces | A / F | Core physical/operational object and exact capacity. Make it map-first. |
| Blocks | B / F | Essential temporary safety/availability record. Present as “Block this space,” not a configuration concept. |
| Layout objects | B, with landmarks A | Generic elements are needed for draft/publish map geometry. Let owners draw landmarks and labels, but hide keys/links/coordinates. |
| Drafts / published layouts | B / F | Required safety boundary. Present as “Saved draft” and “Published customer map.” |
| Exact assignments | B / F | Required to prevent double booking and keep history. Show assignment/status to operations, not setup creators. |
| Space status | A / F | Available, reserved, occupied, blocked, inactive are operationally meaningful. Keep state calculation internal. |
| Rate groups/rules | B / C / F | Rates are needed; current rules support location, area and category scope and time priority. Owner needs simple rates, advanced users need overrides. |
| Public visibility | B / F | Needed for customer safety and controlled exposure. Present as “Customers can book/see this” with clear scope. |
| Reservation eligibility | B / F | Must remain a rigorous calculation across active status, publication, compatibility, block and interval. Do not expose it as a data-model task. |

## Direct answers

1. Owners do not need to create objects labelled “zones.”
2. A zone/area matters only where it changes customer selection, arrival/exit route, eligibility, pricing, closure scope, or operating responsibility. The owner need not learn the distinction because it is one record.
3. Daily, weekly, monthly, company, bobtail and shop-controlled can be selected as space/group attributes in the UI. The provisioning layer translates them to category, inventory, rate, public visibility and block/staff policies.
4. Vehicle eligibility can default from a parking-type preset, with an Advanced override. It must still persist to real categories/inventory because booking safety depends on it.
5. Inventory relationships can and should be automatically created/reactivated. The current area-save endpoint already proves this pattern for selected categories.
6. The layout editor can become the primary creation experience, but it needs bulk/group tools and a provisioning API before it replaces the wizard.
7. Backend area/category/inventory records can be generated automatically, subject to deterministic reuse, ownership/audit, validations, and no mutation of historically used records.
8. A simple lot can use one internal default area when all spaces share customer instructions and rules. It remains a required internal join anchor in the current model.
9. Multiple areas are justified for separate facilities/entrances, divergent routes, prices, vehicle eligibility, visibility, closures, or operational teams—not merely for visual rows or labels.
10. Hiding areas/zones does not break features if internal records remain. Deleting/merging referenced records would break public area selection, rate/closure scope, directions, exact spot validation, layout links and historical integrity.

## Why it feels complicated

The workflow asks for conceptual configuration before spatial work; repeats the same classification at area and space creation; mixes rare policy choices with first-time setup; exposes a generic element editor rather than lot primitives; and maintains a parallel technical Configuration surface. The backend model itself is defensible; the exposure order and vocabulary are the problem.
