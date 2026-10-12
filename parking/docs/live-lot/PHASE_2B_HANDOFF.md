# Phase 2B handoff

Phase 2B delivers the read-only operational Live Lot frontend against the Phase 2A API contract. It adds snapshot filtering and future viewing, immutable published-layout rendering, warning presentation, fallback list access, debounced grouped search, selected-space detail, and lazy 30-day timelines.

The screen intentionally does not add payment, a customer-profile page, a new reservation lifecycle, a new check-in/check-out design, physical-space import, numbering, or map digitization. Existing reservation workflows remain the compatible mutation route where the detail action flags make them appropriate.

Phase 3 work includes any explicitly designed operational mutation experience, final customer profiles, richer timeline range controls if product testing calls for them, and map digitization only after the owner-confirmation and source-image blockers in `docs/lot-setup-audit/` are resolved. Do not hardcode space ranges, classifications, or geometry before that confirmation.
