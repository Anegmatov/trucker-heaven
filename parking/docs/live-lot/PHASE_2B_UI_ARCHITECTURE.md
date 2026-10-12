# Phase 2B Live Lot UI architecture

Live Lot is the daily operational workspace in the existing vanilla-JavaScript admin application. It is not a layout editor and does not write operational state.

## State and API consumption

`liveState` keeps the selected location, evaluated instant, snapshot, dedicated filter state, selected space, lazy detail/timeline state, debounced search state, and request IDs. Snapshot and search request IDs make late responses harmless when location, time, or search input changes quickly.

The selected location loads `GET /locations/:locationId/live-lot/snapshot`. The toolbar sends only documented server filters: `at`, `operationalStatus`, `parkingUse`, `vehicleCategoryId`, and `availableOnly`. Configuration-issue and future-booking filters are applied locally to the complete returned snapshot. No geometry or operational state is invented by the frontend.

The workspace has a compact toolbar, summary strip, immutable published-map region, and selected-space panel. A missing published layout shows the documented empty state and only an OWNER sees the route to Lot Diagram.

## Rendering

The map uses `layout.elements` directly: normalized coordinates, rotation, z-order, and active state are retained. Linked spaces are rendered as keyboard-accessible buttons using their server-derived `operationalStatus`; non-space elements are presentational and hidden from assistive technology. The fallback list uses the same snapshot and exposes unplaced spaces on desktop and every visible space on phones.

`parkingUse`, booking visibility, eligibility, future reservations, and warnings remain separate from the operational status. Detail calls and all PII remain in the selected-space panel.
